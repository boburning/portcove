//! Offline construction of the authenticated application-update repository.
//!
//! This boundary consumes the deterministic record tree produced by
//! `reconstruct-application-update-records.mjs`, adds the separately controlled
//! payload-key registry, and signs TUF metadata with distinct role keys. It has
//! no network, publication, credential-provisioning, or runtime-update authority.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Read;
use std::num::NonZeroU64;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use futures_util::TryStreamExt;
use jiff::Timestamp;
use minisign_verify::PublicKey;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tempfile::Builder;
use tough::editor::RepositoryEditor;
use tough::key_source::KeySource;
use tough::schema::{PathPattern, PathSet, RoleType, Root, Signed};
use tough::{RepositoryLoader, TargetName};
use url::Url;

const MAX_CONFIG_BYTES: u64 = 64 * 1024;
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_REGISTRY_BYTES: u64 = 256 * 1024;
const MAX_RECORD_BYTES: u64 = 256 * 1024;
const MAX_RECORDS: usize = 1024;
const MAX_TOTAL_TARGET_BYTES: u64 = 16 * 1024 * 1024;
const MAX_REPOSITORY_FILES: usize = 1100;
const MAX_REPOSITORY_BYTES: u64 = 64 * 1024 * 1024;
const MAX_REPOSITORY_DEPTH: usize = 16;

#[derive(Debug, thiserror::Error)]
pub enum TufRepositoryError {
    #[error("TUF repository I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("TUF repository configuration is malformed: {0}")]
    Json(#[from] serde_json::Error),
    #[error("TUF repository signing failed: {0}")]
    Tough(#[source] Box<tough::error::Error>),
    #[error("TUF repository schema is invalid: {0}")]
    Schema(#[from] tough::schema::Error),
    #[error("TUF repository configuration is invalid: {0}")]
    Invalid(String),
}

impl From<tough::error::Error> for TufRepositoryError {
    fn from(error: tough::error::Error) -> Self {
        Self::Tough(Box::new(error))
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RepositoryConfig {
    schema_version: u32,
    generated_at: String,
    trusted_root: String,
    reconstructed_records: String,
    payload_key_registry: String,
    output: String,
    keys: SigningKeys,
    versions: RoleVersions,
    expires: RoleExpirations,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SigningKeys {
    targets: String,
    snapshot: String,
    timestamp: String,
    releases: String,
    preview: String,
    stable: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RoleVersions {
    targets: u64,
    snapshot: u64,
    timestamp: u64,
    releases: u64,
    preview: u64,
    stable: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RoleExpirations {
    targets: String,
    snapshot: String,
    timestamp: String,
    releases: String,
    preview: String,
    stable: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReconstructionManifest {
    schema_version: u32,
    records: Vec<RecordIdentity>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PayloadKeyRegistry {
    schema_version: u32,
    keys: Vec<PayloadKeyEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PayloadKeyEntry {
    id: String,
    tauri_public_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RecordIdentity {
    kind: String,
    #[serde(default)]
    channel: Option<String>,
    path: String,
    version: String,
    target: String,
    package: String,
    bytes: u64,
    sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RepositoryFileIdentity {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct TufRepositoryReport {
    pub schema_version: u32,
    pub changed: bool,
    pub records: usize,
    pub files: Vec<RepositoryFileIdentity>,
    pub output: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RepositoryManifest {
    schema_version: u32,
    records: usize,
    files: Vec<RepositoryFileIdentity>,
}

#[derive(Clone, Copy)]
enum DelegatedRole {
    Releases,
    Preview,
    Stable,
}

impl DelegatedRole {
    fn name(self) -> &'static str {
        match self {
            Self::Releases => "releases",
            Self::Preview => "preview",
            Self::Stable => "stable",
        }
    }

    fn placeholder_pattern(self) -> &'static str {
        match self {
            Self::Releases => "releases/*/*/*.json",
            Self::Preview => "channels/preview/*/*/*.json",
            Self::Stable => "channels/stable/*/*/*.json",
        }
    }
}

mod validation;

use validation::*;

fn role_records(
    records: &[(RecordIdentity, DelegatedRole, Vec<u8>)],
    role: DelegatedRole,
) -> impl Iterator<Item = &RecordIdentity> {
    records.iter().filter_map(move |(record, record_role, _)| {
        (record_role.name() == role.name()).then_some(record)
    })
}

async fn add_delegated_role(
    editor: &mut RepositoryEditor,
    role: DelegatedRole,
    records: &[(RecordIdentity, DelegatedRole, Vec<u8>)],
    signing_key: &Arc<[u8]>,
    version: NonZeroU64,
    expires: Timestamp,
    target_root: &Path,
) -> Result<(), TufRepositoryError> {
    editor
        .change_delegated_targets(role.name())?
        .targets_version(version)?
        .targets_expires(expires)?;
    for record in role_records(records, role) {
        let target_path = target_root.join(Path::new(&record.path));
        let (_, target) = RepositoryEditor::build_target(&target_path).await?;
        editor.add_target(record.path.as_str(), target)?;
    }
    editor
        .sign_targets_editor(&[key(signing_key.clone())])
        .await?;
    Ok(())
}

/// Build one immutable, offline TUF repository bundle from a strict JSON config.
/// Existing differing output is refused; an exact retry is reported unchanged.
pub async fn build_tuf_repository(
    config_path: &Path,
) -> Result<TufRepositoryReport, TufRepositoryError> {
    let config_bytes = read_regular_bounded(config_path, MAX_CONFIG_BYTES, "repository config")?;
    let config: RepositoryConfig = serde_json::from_slice(&config_bytes)?;
    if config.schema_version != 1 {
        return Err(TufRepositoryError::Invalid(
            "repository config schema is unsupported".into(),
        ));
    }
    let base = config_path.parent().unwrap_or_else(|| Path::new("."));
    let root_path = resolve(base, &config.trusted_root, "trusted root")?;
    let records_root = resolve(base, &config.reconstructed_records, "reconstructed records")?;
    let registry_path = resolve(base, &config.payload_key_registry, "payload-key registry")?;
    let output = resolve(base, &config.output, "repository output")?;
    let source_keys = [
        resolve(base, &config.keys.targets, "targets key")?,
        resolve(base, &config.keys.snapshot, "snapshot key")?,
        resolve(base, &config.keys.timestamp, "timestamp key")?,
        resolve(base, &config.keys.releases, "releases key")?,
        resolve(base, &config.keys.preview, "Preview key")?,
        resolve(base, &config.keys.stable, "Stable key")?,
    ];
    let trusted_root = read_regular_bounded(&root_path, MAX_MANIFEST_BYTES, "trusted root")?;
    let signing_key_bytes = source_keys
        .iter()
        .enumerate()
        .map(|(index, path)| {
            read_regular_bounded(path, MAX_CONFIG_BYTES, &format!("signing key {index}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    ensure_no_overlap(
        &output,
        &[
            root_path.as_path(),
            records_root.as_path(),
            registry_path.as_path(),
            source_keys[0].as_path(),
            source_keys[1].as_path(),
            source_keys[2].as_path(),
            source_keys[3].as_path(),
            source_keys[4].as_path(),
            source_keys[5].as_path(),
        ],
    )?;
    let output_parent = output.parent().ok_or_else(|| {
        TufRepositoryError::Invalid("repository output needs a parent directory".into())
    })?;
    let keys: [Arc<[u8]>; 6] = signing_key_bytes
        .into_iter()
        .map(Arc::<[u8]>::from)
        .collect::<Vec<_>>()
        .try_into()
        .map_err(|_| TufRepositoryError::Invalid("six TUF signing keys are required".into()))?;

    let manifest_path = records_root.join("reconstruction-manifest.json");
    let manifest_bytes = read_regular_bounded(
        &manifest_path,
        MAX_MANIFEST_BYTES,
        "reconstruction manifest",
    )?;
    let manifest: ReconstructionManifest = serde_json::from_slice(&manifest_bytes)?;
    if manifest.schema_version != 1
        || manifest.records.is_empty()
        || manifest.records.len() > MAX_RECORDS
    {
        return Err(TufRepositoryError::Invalid(
            "reconstruction manifest has an invalid schema or record count".into(),
        ));
    }
    let mut seen = BTreeSet::new();
    let mut records = Vec::with_capacity(manifest.records.len());
    let mut total_bytes = 0u64;
    for record in manifest.records {
        let role = validate_record(&record)?;
        if !seen.insert(record.path.clone()) {
            return Err(TufRepositoryError::Invalid(format!(
                "duplicate reconstructed target: {}",
                record.path
            )));
        }
        let bytes = read_regular_bounded(
            &records_root.join(Path::new(&record.path)),
            MAX_RECORD_BYTES,
            "reconstructed record",
        )?;
        if bytes.len() as u64 != record.bytes || sha256(&bytes) != record.sha256 {
            return Err(TufRepositoryError::Invalid(format!(
                "reconstructed record identity changed: {}",
                record.path
            )));
        }
        total_bytes = total_bytes
            .checked_add(record.bytes)
            .filter(|size| *size <= MAX_TOTAL_TARGET_BYTES)
            .ok_or_else(|| {
                TufRepositoryError::Invalid(
                    "reconstructed target set exceeds its total limit".into(),
                )
            })?;
        records.push((record, role, bytes));
    }

    let represented_roles: BTreeSet<_> = records.iter().map(|(_, role, _)| role.name()).collect();
    if records.len() + 3 - represented_roles.len() > MAX_RECORDS {
        return Err(TufRepositoryError::Invalid(
            "delegated target selector count exceeds 1024".into(),
        ));
    }
    let mut reconstructed_files = BTreeMap::new();
    collect_tree(&records_root, "", &mut reconstructed_files)?;
    let expected_reconstructed_files: BTreeSet<_> = seen
        .iter()
        .cloned()
        .chain(["reconstruction-manifest.json".into()])
        .collect();
    if reconstructed_files.keys().cloned().collect::<BTreeSet<_>>() != expected_reconstructed_files
    {
        return Err(TufRepositoryError::Invalid(
            "reconstruction manifest does not exactly inventory its record tree".into(),
        ));
    }

    let registry_bytes =
        read_regular_bounded(&registry_path, MAX_REGISTRY_BYTES, "payload-key registry")?;
    validate_payload_registry(&registry_bytes)?;
    let signed_root: Signed<Root> = serde_json::from_slice(&trusted_root)?;
    signed_root.signed.verify_role(&signed_root)?;
    let root_version = signed_root.signed.version;
    let signing_key_ids = validate_distinct_signing_keys(&keys).await?;

    let versions = [
        nonzero(config.versions.targets, "targets")?,
        nonzero(config.versions.snapshot, "snapshot")?,
        nonzero(config.versions.timestamp, "timestamp")?,
        nonzero(config.versions.releases, "releases")?,
        nonzero(config.versions.preview, "Preview")?,
        nonzero(config.versions.stable, "Stable")?,
    ];
    let expirations = [
        expiration(&config.expires.targets, "targets")?,
        expiration(&config.expires.snapshot, "snapshot")?,
        expiration(&config.expires.timestamp, "timestamp")?,
        expiration(&config.expires.releases, "releases")?,
        expiration(&config.expires.preview, "Preview")?,
        expiration(&config.expires.stable, "Stable")?,
    ];
    let generated_at = expiration(&config.generated_at, "generation time")?;
    let now = Timestamp::now();
    if generated_at
        > now
            .checked_add(Duration::from_secs(5 * 60))
            .map_err(|_| TufRepositoryError::Invalid("generation time overflowed".into()))?
    {
        return Err(TufRepositoryError::Invalid(
            "generation time is unreasonably far in the future".into(),
        ));
    }
    for (expires, maximum, label) in [
        (expirations[0], Duration::from_secs(90 * 86_400), "targets"),
        (expirations[1], Duration::from_secs(7 * 86_400), "snapshot"),
        (expirations[2], Duration::from_secs(48 * 3_600), "timestamp"),
        (expirations[3], Duration::from_secs(90 * 86_400), "releases"),
        (expirations[4], Duration::from_secs(7 * 86_400), "Preview"),
        (expirations[5], Duration::from_secs(7 * 86_400), "Stable"),
    ] {
        expiry_window(generated_at, now, expires, maximum, label)?;
    }
    validate_root_contract(&signed_root.signed, generated_at, now, &signing_key_ids)?;

    let mut expected_targets = BTreeMap::new();
    expected_targets.insert("keys/payload.json".into(), registry_bytes.clone());
    for (record, _, bytes) in &records {
        expected_targets.insert(record.path.clone(), bytes.clone());
    }
    if output.exists() {
        validate_existing_repository(
            &output,
            ExpectedRepository {
                trusted_root: &trusted_root,
                targets: &expected_targets,
                versions: &versions,
                expirations: &expirations,
                record_count: records.len(),
                root_version,
                signing_key_ids: &signing_key_ids,
            },
        )
        .await?;
        return Ok(TufRepositoryReport {
            schema_version: 1,
            changed: false,
            records: records.len(),
            files: report_files(&output)?,
            output,
        });
    }

    let temporary = Builder::new()
        .prefix(".application-update-repository-")
        .tempdir_in(output_parent)?;
    let staged_root = temporary.path();
    let staged_metadata = staged_root.join("metadata");
    let staged_targets = staged_root.join("targets");
    let editor_root = staged_root.join(".editor-root.json");
    fs::create_dir(&staged_metadata)?;
    fs::create_dir(&staged_targets)?;
    fs::write(&editor_root, &trusted_root)?;
    fs::create_dir_all(staged_targets.join("keys"))?;
    fs::write(staged_targets.join("keys/payload.json"), &registry_bytes)?;
    for (record, _, bytes) in &records {
        let destination = staged_targets.join(Path::new(&record.path));
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(destination, bytes)?;
    }

    let mut editor = RepositoryEditor::new(&editor_root).await?;
    editor
        .targets_version(versions[0])?
        .targets_expires(expirations[0])?;
    editor
        .snapshot_version(versions[1])
        .snapshot_expires(expirations[1])
        .timestamp_version(versions[2])
        .timestamp_expires(expirations[2]);
    for (role, key_index, version_index, expiration_index) in [
        (DelegatedRole::Releases, 3usize, 3usize, 3usize),
        (DelegatedRole::Preview, 4usize, 4usize, 4usize),
        (DelegatedRole::Stable, 5usize, 5usize, 5usize),
    ] {
        let patterns: Vec<_> = {
            let exact: Vec<_> = role_records(&records, role)
                .map(|record| PathPattern::new(record.path.clone()))
                .collect::<Result<_, _>>()?;
            if exact.is_empty() {
                vec![PathPattern::new(role.placeholder_pattern())?]
            } else {
                exact
            }
        };
        editor
            .delegate_role(
                role.name(),
                &[key(keys[key_index].clone())],
                PathSet::Paths(patterns),
                true,
                versions[version_index],
                expirations[expiration_index],
                NonZeroU64::MIN,
            )
            .await?;
    }
    let (_, registry_target) =
        RepositoryEditor::build_target(staged_targets.join("keys/payload.json")).await?;
    editor.add_target("keys/payload.json", registry_target)?;
    editor.sign_targets_editor(&[key(keys[0].clone())]).await?;
    add_delegated_role(
        &mut editor,
        DelegatedRole::Releases,
        &records,
        &keys[3],
        versions[3],
        expirations[3],
        &staged_targets,
    )
    .await?;
    add_delegated_role(
        &mut editor,
        DelegatedRole::Preview,
        &records,
        &keys[4],
        versions[4],
        expirations[4],
        &staged_targets,
    )
    .await?;
    add_delegated_role(
        &mut editor,
        DelegatedRole::Stable,
        &records,
        &keys[5],
        versions[5],
        expirations[5],
        &staged_targets,
    )
    .await?;
    editor
        .change_delegated_targets("targets")?
        .targets_version(versions[0])?
        .targets_expires(expirations[0])?;
    editor
        .sign(&[
            key(keys[0].clone()),
            key(keys[1].clone()),
            key(keys[2].clone()),
        ])
        .await?
        .write(&staged_metadata)
        .await?;
    fs::write(
        staged_metadata.join(format!("{root_version}.root.json")),
        &trusted_root,
    )?;
    fs::remove_file(&editor_root)?;

    for (path, bytes) in &expected_targets {
        let physical = staged_targets.join(format!("{}.{}", sha256(bytes), path));
        if let Some(parent) = physical.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(physical, bytes)?;
        fs::remove_file(staged_targets.join(Path::new(path)))?;
    }

    let files = report_files(staged_root)?;
    let repository_manifest = serde_json::to_vec_pretty(&serde_json::json!({
        "schema_version": 1,
        "records": records.len(),
        "files": files,
    }))?;
    fs::write(
        staged_root.join("repository-manifest.json"),
        [repository_manifest.as_slice(), b"\n"].concat(),
    )?;
    validate_existing_repository(
        staged_root,
        ExpectedRepository {
            trusted_root: &trusted_root,
            targets: &expected_targets,
            versions: &versions,
            expirations: &expirations,
            record_count: records.len(),
            root_version,
            signing_key_ids: &signing_key_ids,
        },
    )
    .await?;
    let files = report_files(staged_root)?;

    fs::rename(temporary.path(), &output)?;

    Ok(TufRepositoryReport {
        schema_version: 1,
        changed: true,
        records: records.len(),
        files,
        output,
    })
}
