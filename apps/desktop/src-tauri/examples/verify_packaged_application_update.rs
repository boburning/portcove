use std::path::{Path, PathBuf};

use base64::Engine as _;
use portcove_desktop::application_update::{
    ApplicationChannel, ApplicationCompatibility, ArtifactIdentity, InstallOwner,
    LibraryCompatibility, PackageIdentity, PromotionRecord, QualifiedRun, ReleaseRecord,
    SelectedCandidate, VersionRange,
};
use portcove_desktop::application_update_payload::PayloadVerificationKey;
use portcove_desktop::application_update_staging::ApplicationUpdateStagingStore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

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
    candidate_version: String,
    candidate_sha256: String,
    candidate_bytes: u64,
    payload_key_id: String,
    staged_payload_sha256: Option<String>,
    staged_payload_bytes: Option<u64>,
    staging_has_candidate: bool,
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

fn direct_filename(path: &Path) -> Result<&str, String> {
    path.file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("path has no Unicode filename: {}", path.display()))
}

fn build_candidate(
    inventory: &Inventory,
    inventory_sha256: &str,
    signature: String,
) -> Result<SelectedCandidate, String> {
    if inventory.schema_version != 1
        || inventory.repository != "boburning/portcove"
        || inventory.platform_label != "windows-x86_64"
        || inventory.application_identifier != "io.github.portcove.portcove"
        || inventory.updater.id != "desktop-windows-x86_64-nsis"
        || inventory.updater.target != "windows-x86_64"
        || inventory.updater.format != "nsis"
        || inventory.packages.is_empty()
    {
        return Err("inventory is not the controlled Portcove Windows NSIS candidate".into());
    }
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
            os: "windows".into(),
            architecture: "x86_64".into(),
            execution_context: "installed-current-user".into(),
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
    let public_key = std::fs::read(public_key_path).map_err(|error| error.to_string())?;
    let payload_key_id = lowercase_sha256(&public_key);
    if payload_key_id != inventory.updater.public_key_sha256 {
        return Err("public key does not match the verified inventory".into());
    }
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
    let key = PayloadVerificationKey {
        id: payload_key_id.clone(),
        tauri_public_key: base64::engine::general_purpose::STANDARD.encode(public_key),
    };
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

#[tokio::main]
async fn main() {
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    match verify(&arguments).await {
        Ok(evidence) => println!("{}", serde_json::to_string(&evidence).unwrap()),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
