use std::io::{Read, SeekFrom};
use std::path::{Path, PathBuf};

use tokio::io::{AsyncRead, AsyncSeek, AsyncSeekExt};

use base64::Engine as _;
use portcove_desktop::application_update::{
    ApplicationChannel, ApplicationCompatibility, ArtifactIdentity, InstallOwner,
    LibraryCompatibility, PackageIdentity, PromotionRecord, QualifiedRun, ReleaseRecord,
    SelectedCandidate, VersionRange,
};
use portcove_desktop::application_update_payload::{
    PayloadVerificationError, PayloadVerificationKey, select_payload_verification_key,
    verify_payload,
};
use portcove_desktop::application_update_staging::ApplicationUpdateStagingStore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Input pins are supplied by the independently authenticated public caller.
/// Parsing this configuration does not authenticate a feed or appoint a key.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PublicSignatureControl {
    schema_version: u32,
    payload_path: PathBuf,
    artifact: ArtifactIdentity,
    prior_signature: String,
    prior_payload_key_id: String,
    registry_path: PathBuf,
    registry_sha256: String,
}

fn signature_control_regular(path: &Path, maximum: u64) -> Result<std::fs::Metadata, String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err("signature control input must have an absolute path without traversal".into());
    }
    for parent in path.ancestors() {
        let metadata = std::fs::symlink_metadata(parent).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() {
            return Err("signature control input has a symlink ancestor".into());
        }
    }
    let metadata = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > maximum {
        return Err("signature control input is not a bounded nonempty regular file".into());
    }
    Ok(metadata)
}

fn signature_control_unchanged(
    before: &std::fs::Metadata,
    after: &std::fs::Metadata,
) -> Result<(), String> {
    if !after.is_file()
        || before.len() != after.len()
        || before.modified().ok() != after.modified().ok()
    {
        return Err("signature control input changed during verification".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.dev() != after.dev()
            || before.ino() != after.ino()
            || before.ctime() != after.ctime()
            || before.ctime_nsec() != after.ctime_nsec()
        {
            return Err("signature control input identity changed".into());
        }
    }
    Ok(())
}

fn signature_control_open(path: &Path) -> Result<std::fs::File, String> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Retain read sharing only, and open the leaf itself rather than a reparse target.
        options.share_mode(1).custom_flags(0x0020_0000);
    }
    options.open(path).map_err(|error| error.to_string())
}

fn signature_control_bytes(path: &Path, maximum: u64) -> Result<Vec<u8>, String> {
    let before = signature_control_regular(path, maximum)?;
    let mut file = signature_control_open(path)?;
    signature_control_unchanged(
        &before,
        &file.metadata().map_err(|error| error.to_string())?,
    )?;
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(maximum + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 != before.len() {
        return Err("signature control input length changed".into());
    }
    signature_control_unchanged(
        &before,
        &file.metadata().map_err(|error| error.to_string())?,
    )?;
    signature_control_unchanged(&before, &signature_control_regular(path, maximum)?)?;
    Ok(bytes)
}

async fn exact_signature_mismatch<R: AsyncRead + AsyncSeek + Unpin>(
    payload: &mut R,
    artifact: &ArtifactIdentity,
    prior_signature: &str,
    key: &PayloadVerificationKey,
) -> Result<(), String> {
    // Positive verification must precede the negative control on this same handle.
    verify_payload(payload, artifact, key)
        .await
        .map_err(|error| format!("positive V1 verification failed: {error}"))?;
    payload
        .seek(SeekFrom::Start(0))
        .await
        .map_err(|error| error.to_string())?;
    let mut negative = artifact.clone();
    negative.tauri_signature = prior_signature.to_owned();
    match verify_payload(payload, &negative, key).await {
        Err(PayloadVerificationError::SignatureMismatch) => Ok(()),
        Err(error) => Err(format!(
            "negative control did not yield SignatureMismatch: {error}"
        )),
        Ok(_) => Err("negative control unexpectedly verified".into()),
    }
}

async fn public_signature_control(
    config_path: &Path,
    expected_sha256: &str,
) -> Result<serde_json::Value, String> {
    let raw = signature_control_bytes(config_path, 64 * 1024)?;
    if lowercase_sha256(&raw) != expected_sha256 {
        return Err("signature control config SHA-256 differs".into());
    }
    let config: PublicSignatureControl =
        serde_json::from_slice(&raw).map_err(|error| error.to_string())?;
    if config.schema_version != 1
        || config.prior_payload_key_id != config.artifact.payload_key_id
        || config.artifact.bytes == 0
        || config.artifact.bytes > 2 * 1024 * 1024 * 1024
    {
        return Err("signature control schema, same-key identity or payload bound differs".into());
    }
    let registry = signature_control_bytes(&config.registry_path, 64 * 1024)?;
    if lowercase_sha256(&registry) != config.registry_sha256 {
        return Err("signature control registry SHA-256 differs".into());
    }
    let key = select_payload_verification_key(&registry, &config.artifact.payload_key_id)
        .map_err(|error| error.to_string())?;
    let before = signature_control_regular(&config.payload_path, 2 * 1024 * 1024 * 1024)?;
    let file = signature_control_open(&config.payload_path)?;
    signature_control_unchanged(
        &before,
        &file.metadata().map_err(|error| error.to_string())?,
    )?;
    let mut payload = tokio::fs::File::from_std(file);
    exact_signature_mismatch(
        &mut payload,
        &config.artifact,
        &config.prior_signature,
        &key,
    )
    .await?;
    signature_control_unchanged(
        &before,
        &payload
            .metadata()
            .await
            .map_err(|error| error.to_string())?,
    )?;
    signature_control_unchanged(
        &before,
        &signature_control_regular(&config.payload_path, 2 * 1024 * 1024 * 1024)?,
    )?;
    if signature_control_bytes(config_path, 64 * 1024)? != raw
        || signature_control_bytes(&config.registry_path, 64 * 1024)? != registry
    {
        return Err("signature control pinned inputs changed".into());
    }
    Ok(serde_json::json!({
        "schema_version": 1,
        "kind": "public-signature-control",
        "authority": "none",
        "scope": "shipping payload verifier component only; caller owns public provenance",
        "native_acceptance": "not-established",
        "config_sha256": expected_sha256,
        "registry_sha256": config.registry_sha256,
        "payload_sha256": config.artifact.sha256,
        "payload_bytes": config.artifact.bytes,
        "payload_key_id": key.id,
        "v1_signature_sha256": lowercase_sha256(config.artifact.tauri_signature.as_bytes()),
        "prior_signature_sha256": lowercase_sha256(config.prior_signature.as_bytes()),
        "positive": "verified",
        "negative": "SignatureMismatch"
    }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Inventory {
    schema_version: u32,
    repository: String,
    version: String,
    source_commit: String,
    platform_label: String,
    application_identifier: String,
    packages: Vec<serde_json::Value>,
    updater: InventoryUpdater,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InventoryUpdater {
    id: String,
    target: String,
    format: String,
    filename: String,
    bytes: u64,
    sha256: String,
    signature: InventorySignature,
    public_key_sha256: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InventorySignature {
    filename: String,
    bytes: u64,
    sha256: String,
}

#[derive(Clone, Copy, Serialize)]
enum VerificationCase {
    #[serde(rename = "missing-signature")]
    Missing,
    #[serde(rename = "wrong-signature")]
    Wrong,
    #[serde(rename = "valid-signature")]
    Valid,
}

#[derive(Serialize)]
struct Evidence {
    case: VerificationCase,
    outcome: &'static str,
    error: Option<String>,
    platform_label: String,
    updater_target: String,
    updater_format: String,
    candidate_version: String,
    candidate_sha256: String,
    candidate_bytes: u64,
    payload_key_id: String,
    staged_payload_sha256: Option<String>,
    staged_payload_bytes: Option<u64>,
    staging_has_candidate: bool,
}

struct CandidatePlatform {
    os: &'static str,
    architecture: &'static str,
    execution_context: &'static str,
}

fn usage() -> &'static str {
    "usage: verify_packaged_application_update <missing-signature|wrong-signature|valid-signature> INVENTORY PAYLOAD SIGNATURE_OR_DASH PUBLIC_KEY STAGING"
}

fn parse_case(value: &str) -> Result<VerificationCase, String> {
    match value {
        "missing-signature" => Ok(VerificationCase::Missing),
        "wrong-signature" => Ok(VerificationCase::Wrong),
        "valid-signature" => Ok(VerificationCase::Valid),
        _ => Err(usage().into()),
    }
}

fn lowercase_sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn payload_verification_key(
    public_key_file: &[u8],
    expected_id: &str,
) -> Result<PayloadVerificationKey, String> {
    let public_key_wrapper = std::str::from_utf8(public_key_file)
        .map_err(|_| "Tauri public-key file is not UTF-8".to_owned())?;
    let public_key = base64::engine::general_purpose::STANDARD
        .decode(public_key_wrapper.trim())
        .map_err(|_| "Tauri public-key file is not base64".to_owned())?;
    let id = lowercase_sha256(&public_key);
    if id != expected_id {
        return Err("public key does not match the verified inventory".into());
    }
    Ok(PayloadVerificationKey {
        id,
        tauri_public_key: base64::engine::general_purpose::STANDARD.encode(public_key),
    })
}

fn direct_filename(path: &Path) -> Result<&str, String> {
    path.file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("path has no Unicode filename: {}", path.display()))
}

fn candidate_platform(inventory: &Inventory) -> Result<CandidatePlatform, String> {
    match (
        inventory.platform_label.as_str(),
        inventory.updater.id.as_str(),
        inventory.updater.target.as_str(),
        inventory.updater.format.as_str(),
    ) {
        ("windows-x86_64", "desktop-windows-x86_64-nsis", "windows-x86_64", "nsis") => {
            Ok(CandidatePlatform {
                os: "windows",
                architecture: "x86_64",
                execution_context: "installed-current-user",
            })
        }
        ("macos-x86_64", "desktop-macos-x86_64-app-tar-gz", "darwin-x86_64", "app.tar.gz") => {
            Ok(CandidatePlatform {
                os: "macos",
                architecture: "x86_64",
                execution_context: "controlled-packaged-staging",
            })
        }
        ("macos-aarch64", "desktop-macos-aarch64-app-tar-gz", "darwin-aarch64", "app.tar.gz") => {
            Ok(CandidatePlatform {
                os: "macos",
                architecture: "aarch64",
                execution_context: "controlled-packaged-staging",
            })
        }
        _ => Err("inventory is not an allowed controlled Portcove packaged candidate".into()),
    }
}

fn build_candidate(
    inventory: &Inventory,
    inventory_sha256: &str,
    signature: String,
) -> Result<SelectedCandidate, String> {
    if inventory.schema_version != 1
        || inventory.repository != "boburning/portcove"
        || inventory.application_identifier != "io.github.portcove.portcove"
        || inventory.packages.is_empty()
    {
        return Err("inventory is not an allowed controlled Portcove packaged candidate".into());
    }
    let platform = candidate_platform(inventory)?;
    let release_path = format!(
        "releases/{}/{}/{}.json",
        inventory.version, inventory.updater.target, inventory.updater.format
    );
    let release_sha256 = inventory_sha256.to_owned();
    Ok(SelectedCandidate {
        release_path: release_path.clone(),
        release_sha256: release_sha256.clone(),
        release: ReleaseRecord {
            schema_version: 1,
            version: inventory.version.clone(),
            source_commit: inventory.source_commit.clone(),
            source_tree: inventory.source_commit.clone(),
            qualified_run: QualifiedRun {
                workflow: ".github/workflows/updater-artifact-rehearsal.yml".into(),
                workflow_commit: inventory.source_commit.clone(),
                run_id: 1,
                attempt: 1,
                inventory_sha256: inventory_sha256.to_owned(),
            },
            target: inventory.updater.target.clone(),
            os: platform.os.into(),
            architecture: platform.architecture.into(),
            execution_context: platform.execution_context.into(),
            package: PackageIdentity {
                kind: inventory.updater.format.clone(),
                owner: InstallOwner::Portcove,
                product_id: inventory.application_identifier.clone(),
            },
            artifact: ArtifactIdentity {
                url: format!(
                    "https://github.com/{}/releases/download/v{}/{}",
                    inventory.repository, inventory.version, inventory.updater.filename
                ),
                sha256: inventory.updater.sha256.clone(),
                bytes: inventory.updater.bytes,
                tauri_signature: signature,
                payload_key_id: inventory.updater.public_key_sha256.clone(),
            },
            compatibility: ApplicationCompatibility {
                minimum_os_version: "10.0.0".into(),
                required_capabilities: vec![
                    portcove_core::APPLICATION_UPDATE_LOCK_PROTOCOL.to_owned(),
                ],
                cli_protocol: VersionRange {
                    min: portcove_core::API_SCHEMA_VERSION,
                    max: portcove_core::API_SCHEMA_VERSION,
                },
                catalog_formats: vec![
                    portcove_core::Catalog::embedded()
                        .map_err(|error| error.to_string())?
                        .document()
                        .schema_version,
                ],
                library: LibraryCompatibility {
                    read: VersionRange {
                        min: portcove_core::MIN_LIBRARY_SCHEMA_VERSION,
                        max: portcove_core::LIBRARY_SCHEMA_VERSION,
                    },
                    write_schema: portcove_core::LIBRARY_SCHEMA_VERSION,
                    lock_protocol: portcove_core::APPLICATION_UPDATE_LOCK_PROTOCOL.into(),
                },
            },
            evidence_ids: vec!["controlled-packaged-payload-consumer".into()],
        },
        promotion: PromotionRecord {
            schema_version: 1,
            channel: ApplicationChannel::Preview,
            target: inventory.updater.target.clone(),
            package: inventory.updater.format.clone(),
            version: inventory.version.clone(),
            release_path,
            release_sha256,
            eligible: true,
            production_eligible: false,
            withdrawn: false,
            reason: None,
            required_bridge: None,
        },
    })
}

async fn verify(arguments: &[String]) -> Result<Evidence, String> {
    let [
        case,
        inventory_path,
        payload_path,
        signature_path,
        public_key_path,
        staging_root,
    ] = arguments
    else {
        return Err(usage().into());
    };
    let case = parse_case(case)?;
    let inventory_bytes = std::fs::read(inventory_path).map_err(|error| error.to_string())?;
    let inventory: Inventory =
        serde_json::from_slice(&inventory_bytes).map_err(|error| error.to_string())?;
    let payload_path = PathBuf::from(payload_path);
    if direct_filename(&payload_path)? != inventory.updater.filename {
        return Err("payload filename does not match the verified inventory".into());
    }
    let public_key_file = std::fs::read(public_key_path).map_err(|error| error.to_string())?;
    let key = payload_verification_key(&public_key_file, &inventory.updater.public_key_sha256)?;
    let payload_key_id = key.id.clone();
    let signature = if matches!(case, VerificationCase::Missing) {
        if signature_path != "-" {
            return Err("missing-signature requires '-' instead of a signature path".into());
        }
        String::new()
    } else {
        if direct_filename(Path::new(signature_path))? != inventory.updater.signature.filename {
            return Err("signature filename does not match the verified inventory".into());
        }
        let bytes = std::fs::read(signature_path).map_err(|error| error.to_string())?;
        if matches!(case, VerificationCase::Valid)
            && (bytes.len() as u64 != inventory.updater.signature.bytes
                || lowercase_sha256(&bytes) != inventory.updater.signature.sha256)
        {
            return Err("valid signature does not match the verified inventory".into());
        }
        String::from_utf8(bytes)
            .map_err(|_| "payload signature is not UTF-8".to_owned())?
            .trim_end_matches(['\r', '\n'])
            .to_owned()
    };
    let candidate = build_candidate(&inventory, &lowercase_sha256(&inventory_bytes), signature)?;
    let store = ApplicationUpdateStagingStore::new(PathBuf::from(staging_root))
        .map_err(|error| error.to_string())?;
    let mut payload = tokio::fs::File::open(&payload_path)
        .await
        .map_err(|error| error.to_string())?;
    let result = store.stage(&mut payload, &candidate, &key).await;
    match (case, result) {
        (VerificationCase::Valid, Ok(staged)) => {
            let bytes = tokio::fs::read(&staged.payload_path)
                .await
                .map_err(|error| error.to_string())?;
            let staged_payload_sha256 = lowercase_sha256(&bytes);
            let staging_has_candidate = store
                .reconcile()
                .await
                .map_err(|error| error.to_string())?
                .is_some();
            if bytes.len() as u64 != inventory.updater.bytes
                || staged_payload_sha256 != inventory.updater.sha256
                || !staging_has_candidate
            {
                return Err("staged payload does not match the verified inventory".into());
            }
            Ok(Evidence {
                case,
                outcome: "staged",
                error: None,
                platform_label: inventory.platform_label,
                updater_target: inventory.updater.target,
                updater_format: inventory.updater.format,
                candidate_version: inventory.version,
                candidate_sha256: inventory.updater.sha256,
                candidate_bytes: inventory.updater.bytes,
                payload_key_id,
                staged_payload_sha256: Some(staged_payload_sha256),
                staged_payload_bytes: Some(bytes.len() as u64),
                staging_has_candidate,
            })
        }
        (VerificationCase::Valid, Err(error)) => {
            Err(format!("valid packaged payload was rejected: {error}"))
        }
        (case, Err(error)) => {
            let staging_has_candidate = store
                .reconcile()
                .await
                .map_err(|reconcile| reconcile.to_string())?
                .is_some();
            if staging_has_candidate {
                return Err("rejected packaged payload retained staged authority".into());
            }
            Ok(Evidence {
                case,
                outcome: "rejected",
                error: Some(error.to_string()),
                platform_label: inventory.platform_label,
                updater_target: inventory.updater.target,
                updater_format: inventory.updater.format,
                candidate_version: inventory.version,
                candidate_sha256: inventory.updater.sha256,
                candidate_bytes: inventory.updater.bytes,
                payload_key_id,
                staged_payload_sha256: None,
                staged_payload_bytes: None,
                staging_has_candidate,
            })
        }
        (_, Ok(_)) => Err("invalid packaged payload was accepted".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PUBLIC_KEY: &str = "untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\n";

    const PREHASHED_SIGNATURE: &str = "untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1556193335\tfile:test\ny/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==\n";

    fn public_signature_fixture() -> (ArtifactIdentity, String, Vec<u8>) {
        let id = lowercase_sha256(PUBLIC_KEY.as_bytes());
        let registry = serde_json::to_vec(&serde_json::json!({
            "schema_version": 1,
            "keys": [{"id": id, "tauri_public_key": base64::engine::general_purpose::STANDARD.encode(PUBLIC_KEY)}]
        })).unwrap();
        let valid = base64::engine::general_purpose::STANDARD.encode(PREHASHED_SIGNATURE);
        let mut lines = PREHASHED_SIGNATURE
            .lines()
            .map(str::to_owned)
            .collect::<Vec<_>>();
        let mut signature = base64::engine::general_purpose::STANDARD
            .decode(&lines[1])
            .unwrap();
        signature[10] ^= 1;
        lines[1] = base64::engine::general_purpose::STANDARD.encode(signature);
        let negative = base64::engine::general_purpose::STANDARD.encode(lines.join("\n") + "\n");
        (
            ArtifactIdentity {
                url:
                    "https://github.com/boburning/portcove/releases/download/v1.0.0/public-fixture"
                        .into(),
                sha256: lowercase_sha256(b"test"),
                bytes: 4,
                tauri_signature: valid,
                payload_key_id: id,
            },
            negative,
            registry,
        )
    }

    #[tokio::test]
    async fn public_signature_control_requires_positive_then_exact_signature_mismatch() {
        // The altered public fixture signature is synthetic, not an actual public V0 signature.
        let (artifact, negative, registry) = public_signature_fixture();
        let key = select_payload_verification_key(&registry, &artifact.payload_key_id).unwrap();
        let mut payload = std::io::Cursor::new(b"test");
        exact_signature_mismatch(&mut payload, &artifact, &negative, &key)
            .await
            .unwrap();
        let mut payload = std::io::Cursor::new(b"test");
        assert!(
            exact_signature_mismatch(&mut payload, &artifact, &artifact.tauri_signature, &key)
                .await
                .unwrap_err()
                .contains("unexpectedly verified")
        );
        let mut payload = std::io::Cursor::new(b"test");
        assert!(
            exact_signature_mismatch(&mut payload, &artifact, "not base64", &key)
                .await
                .unwrap_err()
                .contains("did not yield SignatureMismatch")
        );
        let mut changed = artifact.clone();
        changed.sha256 = "0".repeat(64);
        let mut payload = std::io::Cursor::new(b"test");
        assert!(
            exact_signature_mismatch(&mut payload, &changed, &negative, &key)
                .await
                .unwrap_err()
                .contains("positive V1 verification failed")
        );
    }

    #[tokio::test]
    async fn public_signature_control_pins_bounded_actual_files_and_same_key_configuration() {
        let root = tempfile::tempdir().unwrap();
        let (artifact, negative, registry) = public_signature_fixture();
        let payload = root.path().join("payload");
        let registry_path = root.path().join("payload.json");
        let config_path = root.path().join("control.json");
        std::fs::write(&payload, b"test").unwrap();
        std::fs::write(&registry_path, &registry).unwrap();
        let mut config = serde_json::json!({
            "schema_version": 1, "payload_path": payload, "artifact": artifact,
            "prior_signature": negative, "prior_payload_key_id": artifact.payload_key_id,
            "registry_path": registry_path, "registry_sha256": lowercase_sha256(&registry)
        });
        let raw = serde_json::to_vec(&config).unwrap();
        std::fs::write(&config_path, &raw).unwrap();
        let evidence = public_signature_control(&config_path, &lowercase_sha256(&raw))
            .await
            .unwrap();
        assert_eq!(evidence["negative"], "SignatureMismatch");
        assert_eq!(evidence["authority"], "none");
        assert_eq!(evidence["native_acceptance"], "not-established");
        assert!(
            public_signature_control(&config_path, &"0".repeat(64))
                .await
                .is_err()
        );
        config["prior_payload_key_id"] = serde_json::json!("0".repeat(64));
        let changed = serde_json::to_vec(&config).unwrap();
        std::fs::write(&config_path, &changed).unwrap();
        assert!(
            public_signature_control(&config_path, &lowercase_sha256(&changed))
                .await
                .unwrap_err()
                .contains("same-key")
        );
        std::fs::write(&config_path, vec![b' '; 64 * 1024 + 1]).unwrap();
        assert!(
            public_signature_control(&config_path, &"0".repeat(64))
                .await
                .is_err()
        );
    }

    fn inventory(platform_label: &str, id: &str, target: &str, format: &str) -> Inventory {
        serde_json::from_value(serde_json::json!({
            "schema_version": 1,
            "repository": "boburning/portcove",
            "version": "1.0.0",
            "source_commit": "a".repeat(40),
            "platform_label": platform_label,
            "application_identifier": "io.github.portcove.portcove",
            "packages": [{}],
            "updater": {
                "id": id,
                "target": target,
                "format": format,
                "filename": "payload",
                "bytes": 1,
                "sha256": "b".repeat(64),
                "signature": {
                    "filename": "payload.sig",
                    "bytes": 1,
                    "sha256": "c".repeat(64)
                },
                "public_key_sha256": "d".repeat(64)
            }
        }))
        .unwrap()
    }

    #[test]
    fn tauri_wrapper_is_decoded_before_key_identity_is_hashed() {
        let wrapped = format!(
            "{}\n",
            base64::engine::general_purpose::STANDARD.encode(PUBLIC_KEY)
        );
        let expected_id = lowercase_sha256(PUBLIC_KEY.as_bytes());
        let key = payload_verification_key(wrapped.as_bytes(), &expected_id).unwrap();
        assert_eq!(key.id, expected_id);
        assert_eq!(
            key.tauri_public_key,
            base64::engine::general_purpose::STANDARD.encode(PUBLIC_KEY)
        );
        assert_ne!(key.id, lowercase_sha256(wrapped.as_bytes()));
    }

    #[test]
    fn packaged_candidate_platforms_are_exactly_allowlisted() {
        for (inventory, os, architecture, execution_context) in [
            (
                inventory(
                    "windows-x86_64",
                    "desktop-windows-x86_64-nsis",
                    "windows-x86_64",
                    "nsis",
                ),
                "windows",
                "x86_64",
                "installed-current-user",
            ),
            (
                inventory(
                    "macos-x86_64",
                    "desktop-macos-x86_64-app-tar-gz",
                    "darwin-x86_64",
                    "app.tar.gz",
                ),
                "macos",
                "x86_64",
                "controlled-packaged-staging",
            ),
            (
                inventory(
                    "macos-aarch64",
                    "desktop-macos-aarch64-app-tar-gz",
                    "darwin-aarch64",
                    "app.tar.gz",
                ),
                "macos",
                "aarch64",
                "controlled-packaged-staging",
            ),
        ] {
            let platform = candidate_platform(&inventory).unwrap();
            assert_eq!(platform.os, os);
            assert_eq!(platform.architecture, architecture);
            assert_eq!(platform.execution_context, execution_context);
        }

        let crossed = inventory(
            "macos-aarch64",
            "desktop-macos-aarch64-app-tar-gz",
            "darwin-x86_64",
            "app.tar.gz",
        );
        assert!(candidate_platform(&crossed).is_err());
    }
}

#[tokio::main]
async fn main() {
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    let outcome = if arguments.first().map(String::as_str) == Some("public-signature-control") {
        match arguments.as_slice() {
            [_, config, sha256] => public_signature_control(Path::new(config), sha256).await.and_then(|value| serde_json::to_string(&value).map_err(|error| error.to_string())),
            _ => Err("usage: verify_packaged_application_update public-signature-control CONFIG CONFIG_SHA256".into()),
        }
    } else {
        verify(&arguments).await.and_then(|evidence| {
            serde_json::to_string(&evidence).map_err(|error| error.to_string())
        })
    };
    match outcome {
        Ok(evidence) => println!("{evidence}"),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
