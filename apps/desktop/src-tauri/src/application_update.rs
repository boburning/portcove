//! Host-owned application update metadata contracts and deterministic selection.
//!
//! `application_update_repository` obtains both byte slices from fully consumed,
//! authenticated TUF target streams. This module validates their Portcove
//! contracts and binds the separately authorized promotion to the immutable
//! release record. It does not fetch metadata, persist trust state, download
//! payloads, or apply an update.

use std::cmp::Ordering;
use std::collections::BTreeSet;

use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::Url;

const MAX_RECORD_BYTES: usize = 256 * 1024;
const MAX_PAYLOAD_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_SIGNATURE_CHARS: usize = 16 * 1024;
const MAX_REASON_CHARS: usize = 512;
const MAX_ARTIFACT_URL_BYTES: usize = 8 * 1024;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum UpdateMetadataError {
    #[error("authenticated update record exceeds its parsing limit")]
    TooLarge,
    #[error("authenticated update record is malformed: {0}")]
    Malformed(String),
    #[error("authenticated update identity is invalid: {0}")]
    InvalidIdentity(String),
    #[error("channel promotion does not bind the authenticated release record")]
    PromotionMismatch,
    #[error("ambiguous candidates have equal SemVer precedence")]
    AmbiguousPrecedence,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ApplicationChannel {
    Preview,
    Stable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum InstallOwner {
    Portcove,
    PackageManager,
    Manual,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QualifiedRun {
    pub workflow: String,
    pub workflow_commit: String,
    pub run_id: u64,
    pub attempt: u64,
    pub inventory_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PackageIdentity {
    pub kind: String,
    pub owner: InstallOwner,
    pub product_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArtifactIdentity {
    pub url: String,
    pub sha256: String,
    pub bytes: u64,
    pub tauri_signature: String,
    pub payload_key_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VersionRange {
    pub min: u32,
    pub max: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LibraryCompatibility {
    pub read: VersionRange,
    pub write_schema: u32,
    pub lock_protocol: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApplicationCompatibility {
    pub minimum_os_version: String,
    pub required_capabilities: Vec<String>,
    pub cli_protocol: VersionRange,
    pub catalog_formats: Vec<u32>,
    pub library: LibraryCompatibility,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReleaseRecord {
    pub schema_version: u32,
    pub version: String,
    pub source_commit: String,
    pub source_tree: String,
    pub qualified_run: QualifiedRun,
    pub target: String,
    pub os: String,
    pub architecture: String,
    pub execution_context: String,
    pub package: PackageIdentity,
    pub artifact: ArtifactIdentity,
    pub compatibility: ApplicationCompatibility,
    pub evidence_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PromotionRecord {
    pub schema_version: u32,
    pub channel: ApplicationChannel,
    pub target: String,
    pub package: String,
    pub version: String,
    pub release_path: String,
    pub release_sha256: String,
    pub eligible: bool,
    pub production_eligible: bool,
    pub withdrawn: bool,
    pub reason: Option<String>,
    pub required_bridge: Option<AuthenticatedTargetReference>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuthenticatedTargetReference {
    pub path: String,
    pub sha256: String,
}

/// A release record and channel promotion already authenticated by the caller.
/// Authentication must finish before these borrowed bytes are supplied.
#[derive(Debug, Clone, Copy)]
pub struct AuthenticatedRecordPair<'a> {
    pub release_path: &'a str,
    pub release_bytes: &'a [u8],
    pub promotion_bytes: &'a [u8],
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InstalledApplicationContext {
    pub current_version: String,
    pub target: String,
    pub os: String,
    pub os_version: String,
    pub architecture: String,
    pub execution_context: String,
    pub package_kind: String,
    pub install_owner: InstallOwner,
    pub product_id: String,
    pub capabilities: BTreeSet<String>,
    pub cli_protocol: u32,
    pub catalog_format: u32,
    pub library_schema: u32,
    pub library_write_schema: u32,
    pub lock_protocol: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CandidateState {
    UpdateAvailable,
    Current,
    Held,
    Incompatible,
    NoCandidate,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SelectedCandidate {
    pub release_path: String,
    pub release_sha256: String,
    pub release: ReleaseRecord,
    pub promotion: PromotionRecord,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CandidateSelection {
    pub state: CandidateState,
    pub candidate: Option<SelectedCandidate>,
    pub reasons: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, schemars::JsonSchema)]
pub struct ApplicationUpdateCandidateSummary {
    pub version: String,
    pub channel: ApplicationChannel,
    pub bytes: u64,
}

impl From<&SelectedCandidate> for ApplicationUpdateCandidateSummary {
    fn from(candidate: &SelectedCandidate) -> Self {
        Self {
            version: candidate.release.version.clone(),
            channel: candidate.promotion.channel,
            bytes: candidate.release.artifact.bytes,
        }
    }
}

fn parse_record<T: for<'de> Deserialize<'de>>(bytes: &[u8]) -> Result<T, UpdateMetadataError> {
    if bytes.is_empty() || bytes.len() > MAX_RECORD_BYTES {
        return Err(UpdateMetadataError::TooLarge);
    }
    serde_json::from_slice(bytes).map_err(|error| UpdateMetadataError::Malformed(error.to_string()))
}

fn canonical_version(value: &str, label: &str) -> Result<Version, UpdateMetadataError> {
    let version = Version::parse(value)
        .map_err(|_| UpdateMetadataError::InvalidIdentity(format!("{label} is not SemVer")))?;
    if version.to_string() != value {
        return Err(UpdateMetadataError::InvalidIdentity(format!(
            "{label} is not canonical SemVer"
        )));
    }
    Ok(version)
}

fn bounded_text(value: &str, label: &str, max: usize) -> Result<(), UpdateMetadataError> {
    if value.is_empty()
        || value.len() > max
        || value.chars().any(|character| character.is_control())
    {
        return Err(UpdateMetadataError::InvalidIdentity(label.into()));
    }
    Ok(())
}

fn identity(value: &str, label: &str) -> Result<(), UpdateMetadataError> {
    bounded_text(value, label, 128)?;
    let bytes = value.as_bytes();
    if !bytes.first().is_some_and(u8::is_ascii_alphanumeric)
        || !bytes.last().is_some_and(u8::is_ascii_alphanumeric)
        || !bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(UpdateMetadataError::InvalidIdentity(label.into()));
    }
    Ok(())
}

fn lowercase_hex(value: &str, length: usize, label: &str) -> Result<(), UpdateMetadataError> {
    if value.len() != length
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(UpdateMetadataError::InvalidIdentity(label.into()));
    }
    Ok(())
}

fn version_range(range: &VersionRange, label: &str) -> Result<(), UpdateMetadataError> {
    if range.min == 0 || range.max < range.min {
        return Err(UpdateMetadataError::InvalidIdentity(label.into()));
    }
    Ok(())
}

fn target_path(value: &str, label: &str) -> Result<(), UpdateMetadataError> {
    bounded_text(value, label, 256)?;
    if value.contains('\\')
        || value.starts_with('/')
        || value.split('/').any(|segment| {
            segment.is_empty()
                || matches!(segment, "." | "..")
                || !segment.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b'+')
                })
        })
    {
        return Err(UpdateMetadataError::InvalidIdentity(label.into()));
    }
    Ok(())
}

fn validate_asset(asset: &ArtifactIdentity, version: &str) -> Result<(), UpdateMetadataError> {
    lowercase_hex(&asset.sha256, 64, "artifact SHA-256")?;
    lowercase_hex(&asset.payload_key_id, 64, "payload key ID")?;
    if asset.bytes == 0 || asset.bytes > MAX_PAYLOAD_BYTES {
        return Err(UpdateMetadataError::InvalidIdentity("artifact size".into()));
    }
    bounded_text(
        &asset.tauri_signature,
        "Tauri signature",
        MAX_SIGNATURE_CHARS,
    )?;
    validate_artifact_url(&asset.url, version)?;
    Ok(())
}

pub(crate) fn validate_artifact_url(
    value: &str,
    version: &str,
) -> Result<Url, UpdateMetadataError> {
    let url = Url::parse(value)
        .map_err(|_| UpdateMetadataError::InvalidIdentity("artifact URL".into()))?;
    let segments = url
        .path_segments()
        .map(Iterator::collect::<Vec<_>>)
        .unwrap_or_default();
    if value.len() > MAX_ARTIFACT_URL_BYTES
        || url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || segments.len() != 6
        || segments[..4] != ["boburning", "portcove", "releases", "download"]
        || segments[4] != format!("v{version}")
        || target_path(segments[5], "artifact filename").is_err()
        || url.path().contains('%')
    {
        return Err(UpdateMetadataError::InvalidIdentity("artifact URL".into()));
    }
    Ok(url)
}

fn validate_release(record: &ReleaseRecord) -> Result<Version, UpdateMetadataError> {
    if record.schema_version != 1 {
        return Err(UpdateMetadataError::InvalidIdentity(
            "release schema version".into(),
        ));
    }
    let version = canonical_version(&record.version, "release version")?;
    lowercase_hex(&record.source_commit, 40, "source commit")?;
    lowercase_hex(&record.source_tree, 40, "source tree")?;
    bounded_text(&record.qualified_run.workflow, "qualified workflow", 256)?;
    lowercase_hex(
        &record.qualified_run.workflow_commit,
        40,
        "qualified workflow commit",
    )?;
    lowercase_hex(
        &record.qualified_run.inventory_sha256,
        64,
        "qualified inventory SHA-256",
    )?;
    if record.qualified_run.run_id == 0 || record.qualified_run.attempt == 0 {
        return Err(UpdateMetadataError::InvalidIdentity("qualified run".into()));
    }
    for (value, label) in [
        (&record.target, "release target"),
        (&record.os, "release OS"),
        (&record.architecture, "release architecture"),
        (&record.execution_context, "release execution context"),
        (&record.package.kind, "release package"),
        (&record.package.product_id, "release product ID"),
    ] {
        identity(value, label)?;
    }
    validate_asset(&record.artifact, &record.version)?;
    canonical_version(
        &record.compatibility.minimum_os_version,
        "minimum OS version",
    )?;
    version_range(&record.compatibility.cli_protocol, "CLI protocol range")?;
    version_range(&record.compatibility.library.read, "library read range")?;
    if record.compatibility.library.write_schema == 0 {
        return Err(UpdateMetadataError::InvalidIdentity(
            "library write schema".into(),
        ));
    }
    identity(
        &record.compatibility.library.lock_protocol,
        "library lock protocol",
    )?;
    if record.compatibility.catalog_formats.is_empty()
        || record.compatibility.catalog_formats.contains(&0)
        || record.compatibility.catalog_formats.len() > 16
    {
        return Err(UpdateMetadataError::InvalidIdentity(
            "catalog formats".into(),
        ));
    }
    if record
        .compatibility
        .catalog_formats
        .iter()
        .collect::<BTreeSet<_>>()
        .len()
        != record.compatibility.catalog_formats.len()
    {
        return Err(UpdateMetadataError::InvalidIdentity(
            "duplicate catalog format".into(),
        ));
    }
    if record.compatibility.required_capabilities.len() > 64 {
        return Err(UpdateMetadataError::InvalidIdentity(
            "required capabilities".into(),
        ));
    }
    let mut capabilities = BTreeSet::new();
    for capability in &record.compatibility.required_capabilities {
        identity(capability, "required capability")?;
        if !capabilities.insert(capability) {
            return Err(UpdateMetadataError::InvalidIdentity(
                "duplicate required capability".into(),
            ));
        }
    }
    if record.evidence_ids.is_empty() || record.evidence_ids.len() > 32 {
        return Err(UpdateMetadataError::InvalidIdentity("evidence IDs".into()));
    }
    for evidence in &record.evidence_ids {
        bounded_text(evidence, "evidence ID", 256)?;
    }
    if record.evidence_ids.iter().collect::<BTreeSet<_>>().len() != record.evidence_ids.len() {
        return Err(UpdateMetadataError::InvalidIdentity(
            "duplicate evidence ID".into(),
        ));
    }
    Ok(version)
}

fn validate_promotion(
    promotion: &PromotionRecord,
    channel: ApplicationChannel,
) -> Result<Version, UpdateMetadataError> {
    if promotion.schema_version != 1 || promotion.channel != channel {
        return Err(UpdateMetadataError::InvalidIdentity(
            "promotion channel or schema".into(),
        ));
    }
    identity(&promotion.target, "promotion target")?;
    identity(&promotion.package, "promotion package")?;
    lowercase_hex(&promotion.release_sha256, 64, "release record SHA-256")?;
    let version = canonical_version(&promotion.version, "promotion version")?;
    if promotion.withdrawn && promotion.eligible {
        return Err(UpdateMetadataError::InvalidIdentity(
            "withdrawn promotion cannot be eligible".into(),
        ));
    }
    if (!promotion.eligible || promotion.withdrawn) && promotion.reason.is_none() {
        return Err(UpdateMetadataError::InvalidIdentity(
            "inactive promotion requires a reason".into(),
        ));
    }
    if let Some(reason) = &promotion.reason {
        bounded_text(reason, "promotion reason", MAX_REASON_CHARS)?;
    }
    if let Some(bridge) = &promotion.required_bridge {
        target_path(&bridge.path, "required bridge path")?;
        lowercase_hex(&bridge.sha256, 64, "required bridge SHA-256")?;
    }
    if promotion.production_eligible && (version.major == 0 || !version.pre.is_empty()) {
        return Err(UpdateMetadataError::InvalidIdentity(
            "0.x and prerelease versions cannot be production eligible".into(),
        ));
    }
    if channel == ApplicationChannel::Stable
        && (!promotion.production_eligible || version.major == 0 || !version.pre.is_empty())
    {
        return Err(UpdateMetadataError::InvalidIdentity(
            "Stable requires explicit production eligibility".into(),
        ));
    }
    Ok(version)
}

pub(crate) fn validate_context(
    context: &InstalledApplicationContext,
) -> Result<Version, UpdateMetadataError> {
    for (value, label) in [
        (&context.target, "installed target"),
        (&context.os, "installed OS"),
        (&context.architecture, "installed architecture"),
        (&context.execution_context, "installed execution context"),
        (&context.package_kind, "installed package"),
        (&context.product_id, "installed product ID"),
        (&context.lock_protocol, "installed lock protocol"),
    ] {
        identity(value, label)?;
    }
    for capability in &context.capabilities {
        identity(capability, "installed capability")?;
    }
    canonical_version(&context.os_version, "installed OS version")?;
    if [
        context.cli_protocol,
        context.catalog_format,
        context.library_schema,
        context.library_write_schema,
    ]
    .contains(&0)
    {
        return Err(UpdateMetadataError::InvalidIdentity(
            "installed compatibility version".into(),
        ));
    }
    canonical_version(&context.current_version, "installed version")
}

fn compatibility_reasons(
    release: &ReleaseRecord,
    context: &InstalledApplicationContext,
) -> Result<Vec<String>, UpdateMetadataError> {
    let mut reasons = Vec::new();
    for (matches, reason) in [
        (release.target == context.target, "target mismatch"),
        (release.os == context.os, "OS mismatch"),
        (
            release.architecture == context.architecture,
            "architecture mismatch",
        ),
        (
            release.execution_context == context.execution_context,
            "execution context mismatch",
        ),
        (
            release.package.kind == context.package_kind,
            "package mismatch",
        ),
        (
            release.package.owner == context.install_owner,
            "owner mismatch",
        ),
        (
            release.package.product_id == context.product_id,
            "product mismatch",
        ),
    ] {
        if !matches {
            reasons.push(reason.into());
        }
    }
    let current_os = canonical_version(&context.os_version, "installed OS version")?;
    let minimum_os = canonical_version(
        &release.compatibility.minimum_os_version,
        "minimum OS version",
    )?;
    if current_os.cmp_precedence(&minimum_os) == Ordering::Less {
        reasons.push("minimum OS version is not met".into());
    }
    for required in &release.compatibility.required_capabilities {
        if !context.capabilities.contains(required) {
            reasons.push(format!("missing capability {required}"));
        }
    }
    let cli = &release.compatibility.cli_protocol;
    if !(cli.min..=cli.max).contains(&context.cli_protocol) {
        reasons.push("CLI protocol mismatch".into());
    }
    if !release
        .compatibility
        .catalog_formats
        .contains(&context.catalog_format)
    {
        reasons.push("catalog format mismatch".into());
    }
    let library = &release.compatibility.library;
    if !(library.read.min..=library.read.max).contains(&context.library_schema) {
        reasons.push("library read schema mismatch".into());
    }
    if library.write_schema != context.library_write_schema {
        reasons.push("library write schema mismatch".into());
    }
    if library.lock_protocol != context.lock_protocol {
        reasons.push("library lock protocol mismatch".into());
    }
    Ok(reasons)
}

fn selected(release: ReleaseRecord, promotion: &PromotionRecord) -> SelectedCandidate {
    SelectedCandidate {
        release_path: promotion.release_path.clone(),
        release_sha256: promotion.release_sha256.clone(),
        release,
        promotion: promotion.clone(),
    }
}

/// Revalidates a selected candidate after it crosses a durable host-state
/// boundary. The authenticated release digest still needs a fresh metadata
/// check immediately before application.
pub(crate) fn validate_selected_candidate(
    candidate: &SelectedCandidate,
) -> Result<(), UpdateMetadataError> {
    let release_version = validate_release(&candidate.release)?;
    let promotion_version = validate_promotion(&candidate.promotion, candidate.promotion.channel)?;
    let expected_path = format!(
        "releases/{}/{}/{}.json",
        candidate.release.version, candidate.release.target, candidate.release.package.kind
    );
    if candidate.release_path != candidate.promotion.release_path
        || candidate.release_sha256 != candidate.promotion.release_sha256
        || candidate.release_path != expected_path
        || candidate.promotion.version != candidate.release.version
        || candidate.promotion.target != candidate.release.target
        || candidate.promotion.package != candidate.release.package.kind
        || promotion_version != release_version
        || !candidate.promotion.eligible
        || candidate.promotion.withdrawn
    {
        return Err(UpdateMetadataError::PromotionMismatch);
    }
    Ok(())
}

/// Revalidates a durable candidate against the current installed application
/// context. Fresh authenticated metadata must still reproduce this exact
/// candidate immediately before native replacement.
pub(crate) fn validate_selected_candidate_for_context(
    candidate: &SelectedCandidate,
    channel: ApplicationChannel,
    context: &InstalledApplicationContext,
) -> Result<(), UpdateMetadataError> {
    validate_selected_candidate(candidate)?;
    let current = validate_context(context)?;
    let candidate_version = canonical_version(&candidate.release.version, "candidate version")?;
    if candidate.promotion.channel != channel {
        return Err(UpdateMetadataError::PromotionMismatch);
    }
    let reasons = compatibility_reasons(&candidate.release, context)?;
    if !reasons.is_empty() {
        return Err(UpdateMetadataError::InvalidIdentity(format!(
            "candidate is incompatible with the installed context: {}",
            reasons.join(", ")
        )));
    }
    if candidate_version.cmp_precedence(&current) != Ordering::Greater {
        return Err(UpdateMetadataError::InvalidIdentity(
            "candidate version is not newer than the installed version".into(),
        ));
    }
    Ok(())
}

/// Select the highest compatible candidate by SemVer precedence.
///
/// Publication order and GitHub's latest/prerelease flags are intentionally not
/// inputs. A malformed or mismatched authenticated record fails the entire check.
pub fn select_authenticated_candidate(
    records: &[AuthenticatedRecordPair<'_>],
    channel: ApplicationChannel,
    context: &InstalledApplicationContext,
) -> Result<CandidateSelection, UpdateMetadataError> {
    let current = validate_context(context)?;
    let mut compatible = Vec::new();
    let mut incompatible = Vec::new();
    let mut held = Vec::new();
    for pair in records {
        let release: ReleaseRecord = parse_record(pair.release_bytes)?;
        let release_version = validate_release(&release)?;
        let promotion: PromotionRecord = parse_record(pair.promotion_bytes)?;
        let promotion_version = validate_promotion(&promotion, channel)?;
        let digest = hex::encode(Sha256::digest(pair.release_bytes));
        let expected_path = format!(
            "releases/{}/{}/{}.json",
            release.version, release.target, release.package.kind
        );
        if promotion.release_path != pair.release_path
            || promotion.release_path != expected_path
            || promotion.release_sha256 != digest
            || promotion.version != release.version
            || promotion.target != release.target
            || promotion.package != release.package.kind
            || promotion_version != release_version
        {
            return Err(UpdateMetadataError::PromotionMismatch);
        }
        if !promotion.eligible || promotion.withdrawn {
            held.push(
                promotion
                    .reason
                    .clone()
                    .unwrap_or_else(|| "candidate is held".into()),
            );
            continue;
        }
        let reasons = compatibility_reasons(&release, context)?;
        if reasons.is_empty() {
            compatible.push((release_version, release, promotion));
        } else {
            incompatible.push(format!("{}: {}", release.version, reasons.join(", ")));
        }
    }
    compatible.sort_by(|left, right| right.0.cmp_precedence(&left.0));
    for candidates in compatible.windows(2) {
        if candidates[0].0.cmp_precedence(&candidates[1].0) == Ordering::Equal {
            return Err(UpdateMetadataError::AmbiguousPrecedence);
        }
    }
    if let Some((version, release, promotion)) = compatible.into_iter().next() {
        let ordering = version.cmp_precedence(&current);
        let candidate = selected(release, &promotion);
        return Ok(match ordering {
            Ordering::Greater => CandidateSelection {
                state: CandidateState::UpdateAvailable,
                candidate: Some(candidate),
                reasons: Vec::new(),
            },
            Ordering::Equal => CandidateSelection {
                state: CandidateState::Current,
                candidate: Some(candidate),
                reasons: vec!["installed version has equal SemVer precedence".into()],
            },
            Ordering::Less => CandidateSelection {
                state: CandidateState::Held,
                candidate: Some(candidate),
                reasons: vec!["channel has no compatible non-older version".into()],
            },
        });
    }
    if !incompatible.is_empty() {
        return Ok(CandidateSelection {
            state: CandidateState::Incompatible,
            candidate: None,
            reasons: incompatible,
        });
    }
    if !held.is_empty() {
        return Ok(CandidateSelection {
            state: CandidateState::Held,
            candidate: None,
            reasons: held,
        });
    }
    Ok(CandidateSelection {
        state: CandidateState::NoCandidate,
        candidate: None,
        reasons: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    fn context(version: &str) -> InstalledApplicationContext {
        InstalledApplicationContext {
            current_version: version.into(),
            target: "windows-x86_64".into(),
            os: "windows".into(),
            os_version: "10.0.26200".into(),
            architecture: "x86_64".into(),
            execution_context: "native".into(),
            package_kind: "nsis".into(),
            install_owner: InstallOwner::Portcove,
            product_id: "portcove-desktop".into(),
            capabilities: BTreeSet::from(["host-api-1".into()]),
            cli_protocol: 1,
            catalog_format: 2,
            library_schema: 1,
            library_write_schema: 1,
            lock_protocol: "library-lock-v1".into(),
        }
    }

    fn release(version: &str) -> Value {
        json!({
            "schema_version": 1,
            "version": version,
            "source_commit": "a".repeat(40),
            "source_tree": "b".repeat(40),
            "qualified_run": {
                "workflow": "release.yml",
                "workflow_commit": "e".repeat(40),
                "run_id": 42,
                "attempt": 1,
                "inventory_sha256": "f".repeat(64)
            },
            "target": "windows-x86_64",
            "os": "windows",
            "architecture": "x86_64",
            "execution_context": "native",
            "package": { "kind": "nsis", "owner": "portcove", "product_id": "portcove-desktop" },
            "artifact": {
                "url": format!("https://github.com/boburning/portcove/releases/download/v{version}/Portcove.exe"),
                "sha256": "c".repeat(64),
                "bytes": 1024,
                "tauri_signature": "fixture-signature",
                "payload_key_id": "d".repeat(64)
            },
            "compatibility": {
                "minimum_os_version": "10.0.19045",
                "required_capabilities": ["host-api-1"],
                "cli_protocol": { "min": 1, "max": 2 },
                "catalog_formats": [2],
                "library": {
                    "read": { "min": 1, "max": 2 },
                    "write_schema": 1,
                    "lock_protocol": "library-lock-v1"
                }
            },
            "evidence_ids": ["ci-run-42", "windows-package-42"]
        })
    }

    fn pair(
        version: &str,
        channel: ApplicationChannel,
        production: bool,
    ) -> (String, Vec<u8>, Vec<u8>) {
        let release_bytes = serde_json::to_vec(&release(version)).unwrap();
        let release_path = format!("releases/{version}/windows-x86_64/nsis.json");
        let promotion = json!({
            "schema_version": 1,
            "channel": channel,
            "target": "windows-x86_64",
            "package": "nsis",
            "version": version,
            "release_path": release_path,
            "release_sha256": hex::encode(Sha256::digest(&release_bytes)),
            "eligible": true,
            "production_eligible": production,
            "withdrawn": false,
            "reason": null,
            "required_bridge": null
        });
        (
            release_path,
            release_bytes,
            serde_json::to_vec(&promotion).unwrap(),
        )
    }

    fn select(
        owned: &[(String, Vec<u8>, Vec<u8>)],
        channel: ApplicationChannel,
        current: &str,
    ) -> Result<CandidateSelection, UpdateMetadataError> {
        let borrowed = owned
            .iter()
            .map(|(path, release, promotion)| AuthenticatedRecordPair {
                release_path: path,
                release_bytes: release,
                promotion_bytes: promotion,
            })
            .collect::<Vec<_>>();
        select_authenticated_candidate(&borrowed, channel, &context(current))
    }

    #[test]
    fn selects_highest_compatible_semver_without_publication_order() {
        let owned = [
            pair("0.2.0-beta.9", ApplicationChannel::Preview, false),
            pair("0.2.0-beta.10", ApplicationChannel::Preview, false),
            pair("0.1.9", ApplicationChannel::Preview, false),
        ];
        let result = select(&owned, ApplicationChannel::Preview, "0.1.0").unwrap();
        assert_eq!(result.state, CandidateState::UpdateAvailable);
        assert_eq!(result.candidate.unwrap().release.version, "0.2.0-beta.10");
    }

    #[test]
    fn stable_requires_explicit_production_eligibility() {
        for version in ["0.3.0", "1.0.0-rc.1"] {
            let owned = [pair(version, ApplicationChannel::Stable, false)];
            assert!(matches!(
                select(&owned, ApplicationChannel::Stable, "0.1.0"),
                Err(UpdateMetadataError::InvalidIdentity(message))
                    if message.contains("Stable")
            ));
        }
        let owned = [pair("1.0.0", ApplicationChannel::Stable, true)];
        assert_eq!(
            select(&owned, ApplicationChannel::Stable, "0.3.0")
                .unwrap()
                .state,
            CandidateState::UpdateAvailable
        );
    }

    #[test]
    fn preview_includes_an_eligible_production_final() {
        let owned = [pair("1.0.0", ApplicationChannel::Preview, true)];
        assert_eq!(
            select(&owned, ApplicationChannel::Preview, "1.0.0-rc.2")
                .unwrap()
                .candidate
                .unwrap()
                .release
                .version,
            "1.0.0"
        );
    }

    #[test]
    fn stable_transition_waits_and_equal_precedence_does_not_reinstall() {
        let owned = [pair("1.0.0", ApplicationChannel::Stable, true)];
        let waiting = select(&owned, ApplicationChannel::Stable, "1.1.0-beta.1").unwrap();
        assert_eq!(waiting.state, CandidateState::Held);
        let current = select(&owned, ApplicationChannel::Stable, "1.0.0+installed").unwrap();
        assert_eq!(current.state, CandidateState::Current);
    }

    #[test]
    fn rejects_equal_precedence_build_variants() {
        let owned = [
            pair("0.3.0+one", ApplicationChannel::Preview, false),
            pair("0.3.0+two", ApplicationChannel::Preview, false),
        ];
        assert_eq!(
            select(&owned, ApplicationChannel::Preview, "0.2.0"),
            Err(UpdateMetadataError::AmbiguousPrecedence)
        );
    }

    #[test]
    fn reports_incompatible_target_and_ownership_without_fallback() {
        let owned = [pair("0.3.0", ApplicationChannel::Preview, false)];
        let mut installed = context("0.2.0");
        installed.target = "linux-x86_64".into();
        installed.package_kind = "appimage".into();
        installed.install_owner = InstallOwner::Manual;
        let borrowed = [AuthenticatedRecordPair {
            release_path: &owned[0].0,
            release_bytes: &owned[0].1,
            promotion_bytes: &owned[0].2,
        }];
        let result =
            select_authenticated_candidate(&borrowed, ApplicationChannel::Preview, &installed)
                .unwrap();
        assert_eq!(result.state, CandidateState::Incompatible);
        assert!(result.reasons[0].contains("target mismatch"));
        assert!(result.reasons[0].contains("package mismatch"));
        assert!(result.reasons[0].contains("owner mismatch"));
    }

    #[test]
    fn separately_bound_promotion_rejects_release_tampering() {
        let mut owned = pair("0.3.0", ApplicationChannel::Preview, false);
        let mut changed: Value = serde_json::from_slice(&owned.1).unwrap();
        changed["artifact"]["bytes"] = json!(2048);
        owned.1 = serde_json::to_vec(&changed).unwrap();
        assert_eq!(
            select(&[owned], ApplicationChannel::Preview, "0.2.0"),
            Err(UpdateMetadataError::PromotionMismatch)
        );
    }

    #[test]
    fn unknown_fields_and_oversized_records_fail_closed() {
        let mut owned = pair("0.3.0", ApplicationChannel::Preview, false);
        let mut changed: Value = serde_json::from_slice(&owned.1).unwrap();
        changed["publication_order"] = json!(1);
        owned.1 = serde_json::to_vec(&changed).unwrap();
        assert!(matches!(
            select(&[owned], ApplicationChannel::Preview, "0.2.0"),
            Err(UpdateMetadataError::Malformed(_))
        ));
        let bytes = vec![b' '; MAX_RECORD_BYTES + 1];
        let borrowed = [AuthenticatedRecordPair {
            release_path: "releases/0.3.0/windows-x86_64/nsis.json",
            release_bytes: &bytes,
            promotion_bytes: b"{}",
        }];
        assert_eq!(
            select_authenticated_candidate(
                &borrowed,
                ApplicationChannel::Preview,
                &context("0.2.0")
            ),
            Err(UpdateMetadataError::TooLarge)
        );
    }

    #[test]
    fn held_and_withdrawn_promotions_remain_visible_as_held() {
        let mut owned = pair("0.3.0", ApplicationChannel::Preview, false);
        let mut promotion: Value = serde_json::from_slice(&owned.2).unwrap();
        promotion["eligible"] = json!(false);
        promotion["withdrawn"] = json!(true);
        promotion["reason"] = json!("withdrawn after qualification");
        owned.2 = serde_json::to_vec(&promotion).unwrap();
        let result = select(&[owned], ApplicationChannel::Preview, "0.2.0").unwrap();
        assert_eq!(result.state, CandidateState::Held);
        assert_eq!(result.reasons, ["withdrawn after qualification"]);
    }
}
