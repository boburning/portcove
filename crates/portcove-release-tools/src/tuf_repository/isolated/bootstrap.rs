//! Explicit initial empty feed only. A descriptor binds facts; it does not
//! authenticate initial-site absence, appoint keys or grant publication. The
//! fixed caller must ratify the public Root/offline Targets and setup preimage.
use super::*;

#[derive(Debug, Serialize)]
pub struct BootstrapContextReport {
    pub schema_version: u32,
    pub context_sha256: String,
    pub descriptor_sha256: String,
    pub root_sha256: String,
    pub offline_targets_sha256: String,
    pub payload_key_registry_sha256: String,
    pub initial_records_sha256: String,
    pub versions: BTreeMap<String, String>,
    pub expires: BTreeMap<String, String>,
    pub authority: &'static str,
}

/// Keyless preflight of only the existing explicit initial context. This
/// authenticates public anchors and their constraints, not the setup preimage,
/// its ratification or a permission to sign or publish.
pub async fn inspect_tuf_bootstrap(
    path: &Path,
) -> Result<BootstrapContextReport, TufRepositoryError> {
    let config: ContextConfig = parse_file(path, "initial public context")?;
    if config.previous_repository.is_some() || config.initial_bootstrap.is_none() {
        return invalid("bootstrap inspection requires only an explicit initial context");
    }
    let base = path.parent().unwrap_or_else(|| Path::new("."));
    let initial = resolve(
        base,
        config.initial_bootstrap.as_ref().unwrap(),
        "initial descriptor",
    )?;
    let context = load_context(path).await?;
    let names = [
        "targets",
        "snapshot",
        "timestamp",
        "releases",
        "preview",
        "stable",
    ];
    Ok(BootstrapContextReport {
        schema_version: 1,
        context_sha256: sha256(&read_regular_bounded(
            path,
            MAX_CONFIG_BYTES,
            "initial context",
        )?),
        descriptor_sha256: sha256(&read_regular_bounded(
            &initial,
            MAX_CONFIG_BYTES,
            "initial descriptor",
        )?),
        root_sha256: sha256(&context.root_bytes),
        offline_targets_sha256: sha256(&context.top_bytes),
        payload_key_registry_sha256: sha256(bytes_at(&context.targets, "keys/payload.json")?),
        initial_records_sha256: sha256(b"[]"),
        versions: names
            .iter()
            .enumerate()
            .map(|(index, name)| (name.to_string(), context.versions[index].to_string()))
            .collect(),
        expires: names
            .iter()
            .enumerate()
            .map(|(index, name)| (name.to_string(), context.expires[index].to_string()))
            .collect(),
        authority: "none",
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BootstrapDescriptor {
    schema_version: u32,
    kind: String,
    generated_at: String,
    setup_plan_sha256: String,
    initial_site_preimage_sha256: String,
    root_sha256: String,
    offline_targets_sha256: String,
    payload_key_registry_sha256: String,
    initial_records_sha256: String,
    versions: BTreeMap<String, String>,
    expires: BTreeMap<String, String>,
}

pub(super) fn validate_empty_records(path: &Path) -> Result<(), TufRepositoryError> {
    let manifest: ReconstructionManifest = parse_file(
        &path.join("reconstruction-manifest.json"),
        "initial empty reconstruction manifest",
    )?;
    if manifest.schema_version != 1 || !manifest.records.is_empty() {
        return invalid("initial bootstrap cannot create a published release or channel record");
    }
    let mut files = BTreeMap::new();
    collect_tree(path, "", &mut files)?;
    if files.len() != 1 || !files.contains_key("reconstruction-manifest.json") {
        return invalid("initial empty reconstruction tree contains unlisted files");
    }
    Ok(())
}

pub(super) fn verify_initial_context(
    context: &Context,
    generated: Timestamp,
    path: &Path,
) -> Result<(), TufRepositoryError> {
    let descriptor: BootstrapDescriptor = parse_file(path, "initial bootstrap descriptor")?;
    if descriptor.schema_version != 1
        || descriptor.kind != "application-tuf-initial-bootstrap"
        || descriptor.generated_at != generated.to_string()
    {
        return invalid("unsupported initial bootstrap descriptor or generation time");
    }
    for value in [
        &descriptor.setup_plan_sha256,
        &descriptor.initial_site_preimage_sha256,
        &descriptor.root_sha256,
        &descriptor.offline_targets_sha256,
        &descriptor.payload_key_registry_sha256,
        &descriptor.initial_records_sha256,
    ] {
        if value.len() != 64
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return invalid("initial bootstrap digest must be lowercase SHA256");
        }
    }
    let registry = bytes_at(&context.targets, "keys/payload.json")?;
    if context.records != 0
        || context.targets.len() != 1
        || descriptor.root_sha256 != sha256(&context.root_bytes)
        || descriptor.offline_targets_sha256 != sha256(&context.top_bytes)
        || descriptor.payload_key_registry_sha256 != sha256(registry)
        || descriptor.initial_records_sha256 != sha256(b"[]")
    {
        return invalid(
            "initial bootstrap requires the exact ratified anchors and empty record set",
        );
    }
    let names = [
        "targets",
        "snapshot",
        "timestamp",
        "releases",
        "preview",
        "stable",
    ];
    if descriptor.versions.len() != names.len() || descriptor.expires.len() != names.len() {
        return invalid("initial bootstrap role set differs");
    }
    for (index, name) in names.iter().enumerate() {
        if descriptor.versions.get(*name) != Some(&context.versions[index].to_string())
            || descriptor.expires.get(*name) != Some(&context.expires[index].to_string())
            || (index != 0 && context.versions[index] != NonZeroU64::MIN)
        {
            return invalid(
                "initial bootstrap version or expiry differs from fixed first-generation context",
            );
        }
    }
    Ok(())
}
