//! Routine signing reads exactly one role key. Assembly reads no private keys.
//! Initial seed/root/top-level targets remain independently authorized offline
//! operations. Public configuration and signatures do not grant publication or
//! semantic eligibility. This bounded beta route can only renew empty Stable.

use super::*;
use aws_lc_rs::rand::SystemRandom;
use std::collections::HashMap;
use std::io::Write;
use tough::editor::signed::SignedRole;
use tough::schema::{DelegatedTargets, KeyHolder, Metafile, Snapshot, Targets};

mod bootstrap;
pub use bootstrap::{BootstrapContextReport, inspect_tuf_bootstrap};
pub mod renewal;
pub use renewal::prepare_tuf_renewal;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OnlineRole {
    Releases,
    Preview,
    Stable,
    Snapshot,
    Timestamp,
}

impl OnlineRole {
    pub fn parse(value: &str) -> Result<Self, TufRepositoryError> {
        match value {
            "releases" => Ok(Self::Releases),
            "preview" => Ok(Self::Preview),
            "stable" => Ok(Self::Stable),
            "snapshot" => Ok(Self::Snapshot),
            "timestamp" => Ok(Self::Timestamp),
            _ => invalid("only the five separately authorized online roles are supported"),
        }
    }
    fn name(self) -> &'static str {
        match self {
            Self::Releases => "releases",
            Self::Preview => "preview",
            Self::Stable => "stable",
            Self::Snapshot => "snapshot",
            Self::Timestamp => "timestamp",
        }
    }
    fn index(self) -> usize {
        match self {
            Self::Releases => 3,
            Self::Preview => 4,
            Self::Stable => 5,
            Self::Snapshot => 1,
            Self::Timestamp => 2,
        }
    }
}

const DELEGATED: [(DelegatedRole, OnlineRole); 3] = [
    (DelegatedRole::Releases, OnlineRole::Releases),
    (DelegatedRole::Preview, OnlineRole::Preview),
    (DelegatedRole::Stable, OnlineRole::Stable),
];

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ContextConfig {
    schema_version: u32,
    #[serde(default)]
    initial_root_profile: InitialRootProfile,
    generated_at: String,
    trusted_root: String,
    offline_targets: String,
    payload_key_registry: String,
    reconstructed_records: String,
    #[serde(default)]
    previous_repository: Option<String>,
    #[serde(default)]
    initial_bootstrap: Option<String>,
    versions: RoleVersions,
    expires: RoleExpirations,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SignConfig {
    schema_version: u32,
    context: String,
    signing_key: String,
    output: String,
    #[serde(default)]
    signed_roles: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AssemblyConfig {
    schema_version: u32,
    context: String,
    signed_roles: String,
    output: String,
}

#[derive(Debug, Serialize)]
pub struct RoleReport {
    pub schema_version: u32,
    pub role: String,
    pub changed: bool,
    pub sha256: String,
    pub bytes: usize,
    pub output: PathBuf,
    pub authority: &'static str,
}

struct Context {
    root_bytes: Vec<u8>,
    root: Signed<Root>,
    top_bytes: Vec<u8>,
    top: Signed<Targets>,
    ids: [Vec<u8>; 6],
    versions: [NonZeroU64; 6],
    expires: [Timestamp; 6],
    targets: BTreeMap<String, Vec<u8>>,
    records: usize,
    inputs: Vec<PathBuf>,
    prior_files: BTreeMap<String, Vec<u8>>,
}

fn invalid<T>(message: &str) -> Result<T, TufRepositoryError> {
    Err(TufRepositoryError::Invalid(message.into()))
}

fn parse_file<T: serde::de::DeserializeOwned>(
    path: &Path,
    label: &str,
) -> Result<T, TufRepositoryError> {
    Ok(serde_json::from_slice(&read_regular_bounded(
        path,
        MAX_CONFIG_BYTES,
        label,
    )?)?)
}

fn metadata_identity(bytes: &[u8], version: NonZeroU64) -> Result<Metafile, TufRepositoryError> {
    Ok(serde_json::from_value(
        serde_json::json!({"version": version, "length": bytes.len(), "hashes": {"sha256": sha256(bytes)}}),
    )?)
}

fn public_ids(root: &Root, top: &Targets) -> Result<[Vec<u8>; 6], TufRepositoryError> {
    let mut ids = Vec::new();
    let mut unique = BTreeSet::new();
    let roots = root
        .roles
        .get(&RoleType::Root)
        .ok_or_else(|| TufRepositoryError::Invalid("root quorum absent".into()))?;
    for id in &roots.keyids {
        unique.insert(id.to_vec());
    }
    for role in [RoleType::Targets, RoleType::Snapshot, RoleType::Timestamp] {
        let definition = root
            .roles
            .get(&role)
            .ok_or_else(|| TufRepositoryError::Invalid("top-level role absent".into()))?;
        if definition.keyids.len() != 1 || definition.threshold != NonZeroU64::MIN {
            return invalid("online top-level role must have one distinct key");
        }
        let id = &definition.keyids[0];
        let public = root
            .keys
            .get(id)
            .ok_or_else(|| TufRepositoryError::Invalid("top-level key absent".into()))?;
        if !matches!(public, tough::schema::key::Key::Ed25519 { .. })
            || public.key_id()? != *id
            || !unique.insert(id.to_vec())
        {
            return invalid("role key is not a distinct identity-bound Ed25519 public key");
        }
        ids.push(id.to_vec());
    }
    let delegations = top
        .delegations
        .as_ref()
        .ok_or_else(|| TufRepositoryError::Invalid("offline delegation absent".into()))?;
    for (role, _) in DELEGATED {
        let definition = delegations
            .roles
            .iter()
            .find(|definition| definition.name == role.name())
            .ok_or_else(|| TufRepositoryError::Invalid("delegated role absent".into()))?;
        if definition.keyids.len() != 1 {
            return invalid("delegated role must have one distinct key");
        }
        let id = &definition.keyids[0];
        let public = delegations
            .keys
            .get(id)
            .ok_or_else(|| TufRepositoryError::Invalid("delegated key absent".into()))?;
        if !matches!(public, tough::schema::key::Key::Ed25519 { .. })
            || public.key_id()? != *id
            || !unique.insert(id.to_vec())
        {
            return invalid("delegated key is not distinct from offline/top-level/other role keys");
        }
        ids.push(id.to_vec());
    }
    ids.try_into()
        .map_err(|_| TufRepositoryError::Invalid("role inventory differs".into()))
}

fn write_files(root: &Path, files: &BTreeMap<String, Vec<u8>>) -> Result<(), TufRepositoryError> {
    for (name, bytes) in files {
        target_path(name)?;
        let path = root.join(name);
        fs::create_dir_all(
            path.parent()
                .ok_or_else(|| TufRepositoryError::Invalid("file parent absent".into()))?,
        )?;
        fs::write(path, bytes)?;
    }
    Ok(())
}

fn bytes_at<'a>(
    files: &'a BTreeMap<String, Vec<u8>>,
    name: &str,
) -> Result<&'a [u8], TufRepositoryError> {
    files
        .get(name)
        .map(Vec::as_slice)
        .ok_or_else(|| TufRepositoryError::Invalid(format!("signed input is absent: {name}")))
}

// Refuse non-public inputs before reading any repository file contents. Existing
// byte/file limits still apply when the accepted public tree is snapshotted.
fn inspect_public_tree(
    root: &Path,
    prefix: &str,
    count: &mut usize,
) -> Result<(), TufRepositoryError> {
    if prefix.split('/').count() > MAX_REPOSITORY_DEPTH {
        return invalid("prior public repository exceeds directory-depth limit");
    }
    if !fs::symlink_metadata(root)?.is_dir() {
        return invalid("prior public repository directory is not regular");
    }
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        *count += 1;
        if *count > 4096 {
            return invalid("prior public repository exceeds entry limit");
        }
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| TufRepositoryError::Invalid("prior public path is not UTF-8".into()))?;
        let relative = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}/{name}")
        };
        target_path(&relative)?;
        let metadata = fs::symlink_metadata(entry.path())?;
        if metadata.is_dir() {
            if relative != "metadata" && relative != "targets" && !relative.starts_with("targets/")
            {
                return invalid("prior repository contains a non-public directory");
            }
            inspect_public_tree(&entry.path(), &relative, count)?;
        } else if metadata.is_file() {
            let file_limit = if relative.starts_with("targets/") {
                MAX_RECORD_BYTES
            } else {
                MAX_MANIFEST_BYTES
            };
            if metadata.len() > file_limit {
                return invalid("prior public file exceeds its role byte limit");
            }
            let public = relative == "repository-manifest.json"
                || relative.strip_prefix("metadata/").is_some_and(|name| {
                    name == "timestamp.json"
                        || name.split_once('.').is_some_and(|(version, role)| {
                            version
                                .parse::<NonZeroU64>()
                                .is_ok_and(|parsed| parsed.to_string() == version)
                                && [
                                    "root.json",
                                    "targets.json",
                                    "snapshot.json",
                                    "releases.json",
                                    "preview.json",
                                    "stable.json",
                                ]
                                .contains(&role)
                        })
                })
                || relative.strip_prefix("targets/").is_some_and(|name| {
                    name.split_once('.').is_some_and(|(digest, logical)| {
                        lowercase_sha256(digest, "public target").is_ok()
                            && logical.ends_with(".json")
                    })
                });
            if !public {
                return invalid("prior repository contains a non-public file");
            }
        } else {
            return invalid("prior public repository contains a link or special file");
        }
    }
    Ok(())
}

fn file_identities(files: &BTreeMap<String, Vec<u8>>) -> Vec<RepositoryFileIdentity> {
    files
        .iter()
        .filter(|(name, _)| name.as_str() != "repository-manifest.json")
        .map(|(path, bytes)| RepositoryFileIdentity {
            path: path.clone(),
            bytes: bytes.len() as u64,
            sha256: sha256(bytes),
        })
        .collect()
}

fn manifest_bytes(
    files: &BTreeMap<String, Vec<u8>>,
    records: usize,
) -> Result<Vec<u8>, TufRepositoryError> {
    Ok([serde_json::to_vec_pretty(&serde_json::json!({"schema_version":1,"records":records,"files":file_identities(files)}))?.as_slice(), b"\n"].concat())
}

// Historical roles remain signature/hash verified with the unchanged ratified
// root/delegation keys. Only the current generation grants freshness; expired
// historical envelopes are retained as immutable bytes, never renewal authority.
fn verify_history(
    context: &Context,
    files: &BTreeMap<String, Vec<u8>>,
    versions: &[NonZeroU64; 6],
) -> Result<(), TufRepositoryError> {
    let delegations = context
        .top
        .signed
        .delegations
        .as_ref()
        .ok_or_else(|| TufRepositoryError::Invalid("delegations absent".into()))?;
    let mut referenced = BTreeSet::from([format!(
        "targets/{}.keys/payload.json",
        sha256(&context.targets["keys/payload.json"])
    )]);
    for (path, bytes) in files {
        let Some(name) = path.strip_prefix("metadata/") else {
            continue;
        };
        if name == "timestamp.json" {
            continue;
        }
        let (version, role) = name.split_once('.').ok_or_else(|| {
            TufRepositoryError::Invalid("historical metadata name is invalid".into())
        })?;
        let version = nonzero(
            version
                .parse()
                .map_err(|_| TufRepositoryError::Invalid("historical version is invalid".into()))?,
            "historical role",
        )?;
        if role == "root.json" {
            if version != context.root.signed.version || bytes != &context.root_bytes {
                return invalid("historical root requires separate offline rotation");
            }
        } else if role == "targets.json" {
            if version != context.versions[0] || bytes != &context.top_bytes {
                return invalid("historical offline targets require separate offline rotation");
            }
        } else if role == "snapshot.json" {
            let signed: Signed<Snapshot> = serde_json::from_slice(bytes)?;
            context.root.signed.verify_role(&signed)?;
            if signed.signed.version != version
                || version > versions[1]
                || signed.signed.spec_version != "1.0.0"
                || !signed.signed._extra.is_empty()
                || signed
                    .signed
                    .meta
                    .keys()
                    .map(String::as_str)
                    .collect::<BTreeSet<_>>()
                    != BTreeSet::from([
                        "targets.json",
                        "releases.json",
                        "preview.json",
                        "stable.json",
                    ])
            {
                return invalid("historical snapshot content or version differs");
            }
            for (role_name, identity) in signed.signed.meta {
                let input = bytes_at(
                    files,
                    &format!("metadata/{}.{}", identity.version, role_name),
                )?;
                same_body(&identity, &metadata_identity(input, identity.version)?)?;
            }
        } else {
            let online = OnlineRole::parse(role.strip_suffix(".json").ok_or_else(|| {
                TufRepositoryError::Invalid("historical role is invalid".into())
            })?)?;
            if !matches!(
                online,
                OnlineRole::Releases | OnlineRole::Preview | OnlineRole::Stable
            ) {
                return invalid("unexpected historical role");
            }
            let signed: Signed<Targets> = serde_json::from_slice(bytes)?;
            delegations.verify_role(&signed, online.name())?;
            if signed.signed.version != version
                || version > versions[online.index()]
                || signed.signed.spec_version != "1.0.0"
                || !signed.signed._extra.is_empty()
                || signed
                    .signed
                    .delegations
                    .as_ref()
                    .is_some_and(|delegations| {
                        !delegations.keys.is_empty() || !delegations.roles.is_empty()
                    })
                || signed.signed.targets.len() > MAX_RECORDS
            {
                return invalid("historical delegated content or version differs");
            }
            if online == OnlineRole::Stable && !signed.signed.targets.is_empty() {
                return invalid(
                    "bounded beta requires an authenticated empty prior Stable role, including retained history",
                );
            }
            let mut namespace = delegations.clone();
            namespace.roles.retain(|role| role.name == online.name());
            for (name, target) in signed.signed.targets {
                target_path(name.raw())?;
                if !namespace.target_is_delegated(&name) || target.length > MAX_RECORD_BYTES {
                    return invalid("historical target escapes its delegated namespace or size");
                }
                let path = format!(
                    "targets/{}.{}",
                    hex::encode(&target.hashes.sha256),
                    name.raw()
                );
                let payload = bytes_at(files, &path)?;
                if payload.len() as u64 != target.length
                    || sha256(payload) != hex::encode(&target.hashes.sha256)
                {
                    return invalid("historical target identity differs");
                }
                if online == OnlineRole::Releases
                    && context
                        .targets
                        .get(name.raw())
                        .is_none_or(|expected| expected.as_slice() != payload)
                {
                    return invalid(
                        "immutable published release history: historical published release cannot disappear or change",
                    );
                }
                referenced.insert(path);
            }
        }
    }
    if files
        .keys()
        .filter(|name| name.starts_with("targets/"))
        .cloned()
        .collect::<BTreeSet<_>>()
        != referenced
    {
        return invalid("retained target history has unreferenced or missing bytes");
    }
    Ok(())
}

async fn verify_prior(
    context: &Context,
    path: &Path,
) -> Result<BTreeMap<String, Vec<u8>>, TufRepositoryError> {
    inspect_public_tree(path, "", &mut 0)?;
    let mut files = BTreeMap::new();
    collect_tree(path, "", &mut files)?;
    let timestamp: Signed<tough::schema::Timestamp> =
        serde_json::from_slice(bytes_at(&files, "metadata/timestamp.json")?)?;
    let snapshot_version = timestamp
        .signed
        .meta
        .get("snapshot.json")
        .ok_or_else(|| TufRepositoryError::Invalid("prior snapshot missing".into()))?
        .version;
    let snapshot: Signed<Snapshot> = serde_json::from_slice(bytes_at(
        &files,
        &format!("metadata/{snapshot_version}.snapshot.json"),
    )?)?;
    if timestamp.signed.spec_version != "1.0.0"
        || !timestamp.signed._extra.is_empty()
        || timestamp.signed.meta.len() != 1
        || snapshot.signed.spec_version != "1.0.0"
        || !snapshot.signed._extra.is_empty()
        || snapshot
            .signed
            .meta
            .keys()
            .map(String::as_str)
            .collect::<BTreeSet<_>>()
            != BTreeSet::from([
                "targets.json",
                "releases.json",
                "preview.json",
                "stable.json",
            ])
    {
        return invalid("prior metadata contains unsupported signed content");
    }
    let mut versions = context.versions;
    versions[1] = snapshot.signed.version;
    versions[2] = timestamp.signed.version;
    let mut expires = context.expires;
    expires[1] = snapshot.signed.expires;
    expires[2] = timestamp.signed.expires;
    let mut logical = BTreeMap::new();
    for (name, target) in &context.top.signed.targets {
        let bytes = bytes_at(
            &files,
            &format!(
                "targets/{}.{}",
                hex::encode(&target.hashes.sha256),
                name.raw()
            ),
        )?;
        logical.insert(name.raw().to_owned(), bytes.to_vec());
    }
    for (role, online) in DELEGATED {
        let version = snapshot
            .signed
            .meta
            .get(&format!("{}.json", role.name()))
            .ok_or_else(|| TufRepositoryError::Invalid("prior delegated metadata missing".into()))?
            .version;
        let signed: Signed<Targets> = serde_json::from_slice(bytes_at(
            &files,
            &format!("metadata/{version}.{}.json", role.name()),
        )?)?;
        if signed.signed.spec_version != "1.0.0"
            || !signed.signed._extra.is_empty()
            || signed
                .signed
                .delegations
                .as_ref()
                .is_some_and(|delegations| {
                    !delegations.keys.is_empty() || !delegations.roles.is_empty()
                })
        {
            return invalid("prior delegated role contains unsupported signed content");
        }
        versions[online.index()] = signed.signed.version;
        expires[online.index()] = signed.signed.expires;
        if signed.signed.targets.len() > MAX_RECORDS {
            return invalid("prior role target count exceeds limit");
        }
        for (name, target) in &signed.signed.targets {
            target_path(name.raw())?;
            if target.length > MAX_RECORD_BYTES {
                return invalid("prior target exceeds record limit");
            }
            let bytes = bytes_at(
                &files,
                &format!(
                    "targets/{}.{}",
                    hex::encode(&target.hashes.sha256),
                    name.raw()
                ),
            )?;
            if logical
                .insert(name.raw().to_owned(), bytes.to_vec())
                .is_some()
            {
                return invalid("prior target ownership overlaps");
            }
        }
    }
    if logical.len() > MAX_RECORDS + 1
        || logical
            .values()
            .map(|bytes| bytes.len() as u64)
            .sum::<u64>()
            > MAX_TOTAL_TARGET_BYTES + MAX_REGISTRY_BYTES
    {
        return invalid("prior target count or bytes exceed limit");
    }
    let manifest: RepositoryManifest =
        serde_json::from_slice(bytes_at(&files, "repository-manifest.json")?)?;
    if manifest.schema_version != 1
        || manifest.records != logical.len() - 1
        || manifest.files != file_identities(&files)
    {
        return invalid("prior public manifest differs from its exact retained tree");
    }
    verify_history(context, &files, &versions)?;
    let mut projection = BTreeMap::new();
    for name in [
        format!("metadata/{}.root.json", context.root.signed.version),
        format!("metadata/{}.targets.json", versions[0]),
        format!("metadata/{}.snapshot.json", versions[1]),
        "metadata/timestamp.json".into(),
        format!("metadata/{}.releases.json", versions[3]),
        format!("metadata/{}.preview.json", versions[4]),
        format!("metadata/{}.stable.json", versions[5]),
    ] {
        projection.insert(name.clone(), bytes_at(&files, &name)?.to_vec());
    }
    for (name, bytes) in consistent_target_files(&logical) {
        projection.insert(format!("targets/{name}"), bytes);
    }
    projection.insert(
        "repository-manifest.json".into(),
        manifest_bytes(&projection, logical.len() - 1)?,
    );
    let staged = tempfile::tempdir()?;
    write_files(staged.path(), &projection)?;
    // Safe Tough expiration/signature/target verification over one bounded
    // immutable public snapshot; expired state requires separate recovery.
    validate_existing_repository(
        staged.path(),
        ExpectedRepository {
            trusted_root: &context.root_bytes,
            targets: &logical,
            versions: &versions,
            expirations: &expires,
            record_count: logical.len() - 1,
            root_version: context.root.signed.version,
            signing_key_ids: &context.ids,
            namespace_delegations: true,
            offline_targets: Some(&context.top_bytes),
        },
    )
    .await?;
    for (prior, proposed) in versions.iter().zip(&context.versions).skip(1) {
        if proposed <= prior {
            return invalid("routine role version must advance its authenticated prior floor");
        }
    }
    for (name, bytes) in &logical {
        if name.starts_with("releases/") && context.targets.get(name) != Some(bytes) {
            return invalid("immutable published release history cannot be removed or changed");
        }
        if name.starts_with("channels/stable/") {
            return invalid("bounded beta requires an authenticated empty prior Stable role");
        }
    }
    Ok(files)
}

async fn load_context(path: &Path) -> Result<Context, TufRepositoryError> {
    let config: ContextConfig = parse_file(path, "public signing context")?;
    if config.schema_version != 1 {
        return invalid("unsupported public signing context schema");
    }
    let base = path.parent().unwrap_or_else(|| Path::new("."));
    let root_path = resolve(base, &config.trusted_root, "trusted root")?;
    let top_path = resolve(base, &config.offline_targets, "offline targets")?;
    let registry_path = resolve(base, &config.payload_key_registry, "payload registry")?;
    let records_path = resolve(base, &config.reconstructed_records, "reconstructed records")?;
    let (previous_path, bootstrap_path) = match (
        &config.previous_repository,
        &config.initial_bootstrap,
    ) {
        (Some(previous), None) => (Some(resolve(base, previous, "previous repository")?), None),
        (None, Some(initial)) => (
            None,
            Some(resolve(base, initial, "initial bootstrap descriptor")?),
        ),
        _ => {
            return invalid(
                "exactly one authenticated previous repository or explicit initial bootstrap is required",
            );
        }
    };
    let root_bytes = read_regular_bounded(&root_path, MAX_MANIFEST_BYTES, "trusted root")?;
    let root: Signed<Root> = serde_json::from_slice(&root_bytes)?;
    root.signed.verify_role(&root)?;
    let top_bytes = read_regular_bounded(&top_path, MAX_MANIFEST_BYTES, "offline targets")?;
    let top: Signed<Targets> = serde_json::from_slice(&top_bytes)?;
    root.signed.verify_role(&top)?;
    let ids = public_ids(&root.signed, &top.signed)?;
    let versions = [
        nonzero(config.versions.targets, "targets")?,
        nonzero(config.versions.snapshot, "snapshot")?,
        nonzero(config.versions.timestamp, "timestamp")?,
        nonzero(config.versions.releases, "releases")?,
        nonzero(config.versions.preview, "preview")?,
        nonzero(config.versions.stable, "stable")?,
    ];
    let expires = [
        expiration(&config.expires.targets, "targets")?,
        expiration(&config.expires.snapshot, "snapshot")?,
        expiration(&config.expires.timestamp, "timestamp")?,
        expiration(&config.expires.releases, "releases")?,
        expiration(&config.expires.preview, "preview")?,
        expiration(&config.expires.stable, "stable")?,
    ];
    let generated = expiration(&config.generated_at, "generation time")?;
    let now = Timestamp::now();
    if generated
        > now
            .checked_add(Duration::from_secs(300))
            .map_err(|_| TufRepositoryError::Invalid("time overflow".into()))?
    {
        return invalid("generation time is unreasonably far in the future");
    }
    for (index, days) in [(0, 90), (1, 7), (2, 2), (3, 90), (4, 7), (5, 7)] {
        expiry_window(
            generated,
            now,
            expires[index],
            Duration::from_secs(days * 86400),
            "role",
        )?;
    }
    validate_root_contract(
        &root.signed,
        generated,
        now,
        &ids,
        config.initial_root_profile,
    )?;
    let registry = read_regular_bounded(&registry_path, MAX_REGISTRY_BYTES, "payload registry")?;
    validate_payload_registry(&registry)?;
    online::load_offline_targets(&top_path, &root, &ids, &versions, &expires, &registry)?;
    let record_manifest: ReconstructionManifest = parse_file(
        &records_path.join("reconstruction-manifest.json"),
        "reconstruction manifest",
    )?;
    let records = if bootstrap_path.is_some() || record_manifest.records.is_empty() {
        // A routine empty map still passes verify_prior below: authenticated
        // historical releases cannot disappear merely by declaring no records.
        bootstrap::validate_empty_records(&records_path)?;
        Vec::new()
    } else {
        load_records(&records_path, true)?
    };
    if records
        .iter()
        .any(|(_, role, _)| matches!(role, DelegatedRole::Stable))
    {
        return invalid("empty-Stable beta renewal cannot add or promote a Stable record");
    }
    let count = records.len();
    let mut targets = BTreeMap::from([("keys/payload.json".into(), registry)]);
    for (record, _, bytes) in records {
        targets.insert(record.path, bytes);
    }
    let mut context = Context {
        root_bytes,
        root,
        top_bytes,
        top,
        ids,
        versions,
        expires,
        targets,
        records: count,
        prior_files: BTreeMap::new(),
        inputs: vec![
            path.to_path_buf(),
            root_path,
            top_path,
            registry_path,
            records_path,
        ],
    };
    if let Some(previous) = previous_path {
        context.inputs.push(previous.clone());
        context.prior_files = verify_prior(&context, &previous).await?;
    } else if let Some(initial) = bootstrap_path {
        bootstrap::verify_initial_context(&context, generated, &initial)?;
        context.inputs.push(initial);
    }
    Ok(context)
}

fn expected_targets(context: &Context, role: DelegatedRole) -> Result<Targets, TufRepositoryError> {
    let index = match role {
        DelegatedRole::Releases => 3,
        DelegatedRole::Preview => 4,
        DelegatedRole::Stable => 5,
    };
    let prefix = match role {
        DelegatedRole::Releases => "releases/",
        DelegatedRole::Preview => "channels/preview/",
        DelegatedRole::Stable => "channels/stable/",
    };
    let mut targets = HashMap::new();
    for (name, bytes) in context
        .targets
        .iter()
        .filter(|(name, _)| name.starts_with(prefix))
    {
        let target = serde_json::from_value(
            serde_json::json!({"length":bytes.len(),"hashes":{"sha256":sha256(bytes)}}),
        )?;
        targets.insert(TargetName::new(name)?, target);
    }
    Ok(Targets {
        spec_version: "1.0.0".into(),
        version: context.versions[index],
        expires: context.expires[index],
        targets,
        delegations: None,
        _extra: HashMap::new(),
    })
}

fn same_body<T: Serialize>(actual: &T, expected: &T) -> Result<(), TufRepositoryError> {
    if serde_json::to_value(actual)? != serde_json::to_value(expected)? {
        return invalid(
            "signed role content/version/expiry differs from independently expected input",
        );
    }
    Ok(())
}

fn snapshot(
    context: &Context,
    roles: &BTreeMap<String, Vec<u8>>,
) -> Result<Snapshot, TufRepositoryError> {
    let mut value = Snapshot::new("1.0.0".into(), context.versions[1], context.expires[1]);
    value.meta.insert(
        "targets.json".into(),
        metadata_identity(&context.top_bytes, context.versions[0])?,
    );
    for (_, role) in DELEGATED {
        let bytes = bytes_at(roles, &format!("{}.json", role.name()))?;
        value.meta.insert(
            format!("{}.json", role.name()),
            metadata_identity(bytes, context.versions[role.index()])?,
        );
    }
    Ok(value)
}

fn timestamp(
    context: &Context,
    roles: &BTreeMap<String, Vec<u8>>,
) -> Result<tough::schema::Timestamp, TufRepositoryError> {
    let mut value =
        tough::schema::Timestamp::new("1.0.0".into(), context.versions[2], context.expires[2]);
    value.meta.insert(
        "snapshot.json".into(),
        metadata_identity(bytes_at(roles, "snapshot.json")?, context.versions[1])?,
    );
    Ok(value)
}

fn verify_inputs(
    context: &Context,
    directory: &Path,
    include_snapshot: bool,
    include_timestamp: bool,
) -> Result<BTreeMap<String, Vec<u8>>, TufRepositoryError> {
    // Reject unexpected entries by name before reading any bytes. In particular,
    // a key file cannot become an accidentally consumed assembly input.
    if !fs::symlink_metadata(directory)?.is_dir() {
        return invalid("signed role inputs must be a regular directory");
    }
    let allowed = BTreeSet::from([
        "releases.json",
        "preview.json",
        "stable.json",
        "snapshot.json",
        "timestamp.json",
    ]);
    let mut count = 0;
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        count += 1;
        if count > 5
            || entry
                .file_name()
                .to_str()
                .is_none_or(|name| !allowed.contains(name))
            || !fs::symlink_metadata(entry.path())?.is_file()
        {
            return invalid("signed role directory contains an unexpected entry");
        }
    }
    let mut roles = BTreeMap::new();
    for (delegated, role) in DELEGATED {
        let name = format!("{}.json", role.name());
        let bytes = read_regular_bounded(
            &directory.join(&name),
            MAX_MANIFEST_BYTES,
            "signed delegated input",
        )?;
        let signed: Signed<Targets> = serde_json::from_slice(&bytes)?;
        context
            .top
            .signed
            .delegations
            .as_ref()
            .ok_or_else(|| TufRepositoryError::Invalid("delegations absent".into()))?
            .verify_role(&signed, role.name())?;
        same_body(&signed.signed, &expected_targets(context, delegated)?)?;
        roles.insert(name, bytes);
    }
    if include_snapshot {
        let bytes = read_regular_bounded(
            &directory.join("snapshot.json"),
            MAX_MANIFEST_BYTES,
            "signed snapshot input",
        )?;
        let signed: Signed<Snapshot> = serde_json::from_slice(&bytes)?;
        context.root.signed.verify_role(&signed)?;
        same_body(&signed.signed, &snapshot(context, &roles)?)?;
        roles.insert("snapshot.json".into(), bytes);
    }
    if include_timestamp {
        let bytes = read_regular_bounded(
            &directory.join("timestamp.json"),
            32 * 1024,
            "signed timestamp input",
        )?;
        let signed: Signed<tough::schema::Timestamp> = serde_json::from_slice(&bytes)?;
        context.root.signed.verify_role(&signed)?;
        same_body(&signed.signed, &timestamp(context, &roles)?)?;
        roles.insert("timestamp.json".into(), bytes);
    }
    Ok(roles)
}

fn canonical_envelope(bytes: &[u8]) -> Result<Vec<u8>, TufRepositoryError> {
    let mut value: serde_json::Value = serde_json::from_slice(bytes)?;
    value.sort_all_objects();
    Ok([serde_json::to_vec_pretty(&value)?.as_slice(), b"\n"].concat())
}

fn write_envelope(output: &Path, bytes: &[u8]) -> Result<bool, TufRepositoryError> {
    if output.exists() {
        if read_regular_bounded(output, MAX_MANIFEST_BYTES, "existing signed role")? == bytes {
            return Ok(false);
        }
        return invalid("signed output already exists with different bytes; never overwrite");
    }
    let parent = output
        .parent()
        .ok_or_else(|| TufRepositoryError::Invalid("output parent absent".into()))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    temporary.write_all(bytes)?;
    temporary.as_file().sync_all()?;
    temporary
        .persist_noclobber(output)
        .map_err(|error| TufRepositoryError::Io(error.error))?;
    Ok(true)
}

/// Reads one bounded private key, after all public inputs and prior floors pass.
/// No configuration field can supply another private role, root or targets key.
pub async fn sign_tuf_role(
    role: OnlineRole,
    config_path: &Path,
) -> Result<RoleReport, TufRepositoryError> {
    let config: SignConfig = parse_file(config_path, "isolated role config")?;
    if config.schema_version != 1 {
        return invalid("unsupported isolated role schema");
    }
    let base = config_path.parent().unwrap_or_else(|| Path::new("."));
    let context_path = resolve(base, &config.context, "public context")?;
    let context = load_context(&context_path).await?;
    let private = resolve(base, &config.signing_key, "single role key")?;
    let output = resolve(base, &config.output, "signed role output")?;
    let signed_roles = config
        .signed_roles
        .as_ref()
        .map(|value| resolve(base, value, "signed role inputs"))
        .transpose()?;
    let required = matches!(role, OnlineRole::Snapshot | OnlineRole::Timestamp);
    if required != signed_roles.is_some() {
        return invalid("only snapshot/timestamp require public signed-role inputs");
    }
    let mut inputs: Vec<_> = context.inputs.iter().map(PathBuf::as_path).collect();
    inputs.extend([config_path, private.as_path()]);
    inputs.extend(signed_roles.as_deref());
    ensure_no_overlap(&output, &inputs)?;
    let roles = signed_roles
        .as_ref()
        .map(|directory| verify_inputs(&context, directory, role == OnlineRole::Timestamp, false))
        .transpose()?;
    let private_bytes: Arc<[u8]> =
        read_regular_bounded(&private, MAX_CONFIG_BYTES, "single role key")?.into();
    let public = key(private_bytes.clone())
        .as_sign()
        .await
        .map_err(|_| TufRepositoryError::Invalid("single role key is invalid".into()))?
        .tuf_key();
    if !matches!(public, tough::schema::key::Key::Ed25519 { .. })
        || public.key_id()?.as_ref() != context.ids[role.index()].as_slice()
    {
        return invalid("private key does not belong to this exact authenticated role");
    }
    let keys = [key(private_bytes)];
    let rng = SystemRandom::new();
    let root_holder = KeyHolder::Root(context.root.signed.clone());
    let bytes = match role {
        OnlineRole::Snapshot => SignedRole::new(
            snapshot(
                &context,
                roles
                    .as_ref()
                    .ok_or_else(|| TufRepositoryError::Invalid("signed inputs missing".into()))?,
            )?,
            &root_holder,
            &keys,
            &rng,
        )
        .await?
        .buffer()
        .to_vec(),
        OnlineRole::Timestamp => SignedRole::new(
            timestamp(
                &context,
                roles
                    .as_ref()
                    .ok_or_else(|| TufRepositoryError::Invalid("signed inputs missing".into()))?,
            )?,
            &root_holder,
            &keys,
            &rng,
        )
        .await?
        .buffer()
        .to_vec(),
        _ => {
            let delegated = DELEGATED
                .iter()
                .find(|(_, candidate)| *candidate == role)
                .ok_or_else(|| TufRepositoryError::Invalid("delegated role mismatch".into()))?
                .0;
            let holder =
                KeyHolder::Delegations(context.top.signed.delegations.clone().ok_or_else(
                    || TufRepositoryError::Invalid("offline delegations missing".into()),
                )?);
            SignedRole::new(
                DelegatedTargets {
                    name: role.name().into(),
                    targets: expected_targets(&context, delegated)?,
                },
                &holder,
                &keys,
                &rng,
            )
            .await?
            .buffer()
            .to_vec()
        }
    };
    let bytes = canonical_envelope(&bytes)?;
    let changed = write_envelope(&output, &bytes)?;
    Ok(RoleReport {
        schema_version: 1,
        role: role.name().into(),
        changed,
        sha256: sha256(&bytes),
        bytes: bytes.len(),
        output,
        authority: "none",
    })
}

/// Verify every signed envelope and atomically assemble the existing repository
/// format. This entrypoint has no private-key configuration or key-loading call.
#[derive(Debug, Serialize)]
pub struct KeylessAssemblyReport {
    pub schema_version: u32,
    pub changed: bool,
    pub records: usize,
    pub files: Vec<RepositoryFileIdentity>,
    pub output: PathBuf,
    pub publication: renewal::PublicTufPublication,
}

pub async fn assemble_tuf_repository(
    config_path: &Path,
) -> Result<KeylessAssemblyReport, TufRepositoryError> {
    let config: AssemblyConfig = parse_file(config_path, "keyless assembly config")?;
    if config.schema_version != 1 {
        return invalid("unsupported keyless assembly schema");
    }
    let base = config_path.parent().unwrap_or_else(|| Path::new("."));
    let context = load_context(&resolve(base, &config.context, "public context")?).await?;
    let directory = resolve(base, &config.signed_roles, "signed public roles")?;
    let output = resolve(base, &config.output, "assembled repository")?;
    let mut inputs: Vec<_> = context.inputs.iter().map(PathBuf::as_path).collect();
    inputs.extend([config_path, directory.as_path()]);
    ensure_no_overlap(&output, &inputs)?;
    let roles = verify_inputs(&context, &directory, true, true)?;
    let mut files = BTreeMap::new();
    files.insert(
        format!("metadata/{}.root.json", context.root.signed.version),
        context.root_bytes.clone(),
    );
    files.insert(
        format!("metadata/{}.targets.json", context.versions[0]),
        context.top_bytes.clone(),
    );
    for role in [
        OnlineRole::Releases,
        OnlineRole::Preview,
        OnlineRole::Stable,
        OnlineRole::Snapshot,
        OnlineRole::Timestamp,
    ] {
        let name = if role == OnlineRole::Timestamp {
            "timestamp.json".into()
        } else {
            format!("{}.{}.json", context.versions[role.index()], role.name())
        };
        files.insert(
            format!("metadata/{name}"),
            bytes_at(&roles, &format!("{}.json", role.name()))?.to_vec(),
        );
    }
    for (name, bytes) in consistent_target_files(&context.targets) {
        files.insert(format!("targets/{name}"), bytes);
    }
    let parent = output
        .parent()
        .ok_or_else(|| TufRepositoryError::Invalid("output parent absent".into()))?;
    let staged = Builder::new().prefix(".keyless-tuf-").tempdir_in(parent)?;
    write_files(staged.path(), &files)?;
    let manifest = serde_json::json!({"schema_version":1,"records":context.records,"files":report_files(staged.path())?});
    fs::write(
        staged.path().join("repository-manifest.json"),
        [serde_json::to_vec_pretty(&manifest)?.as_slice(), b"\n"].concat(),
    )?;
    validate_existing_repository(
        staged.path(),
        ExpectedRepository {
            trusted_root: &context.root_bytes,
            targets: &context.targets,
            versions: &context.versions,
            expirations: &context.expires,
            record_count: context.records,
            root_version: context.root.signed.version,
            signing_key_ids: &context.ids,
            namespace_delegations: true,
            offline_targets: Some(&context.top_bytes),
        },
    )
    .await?;
    // Preserve all authenticated immutable metadata/targets. Only the mutable
    // timestamp and derived inventory are replaced by this generation.
    for (name, bytes) in &context.prior_files {
        if name == "metadata/timestamp.json" || name == "repository-manifest.json" {
            continue;
        }
        if files.get(name).is_some_and(|current| current != bytes) {
            return invalid("immutable historical filename collision");
        }
        files.insert(name.clone(), bytes.clone());
    }
    files.insert(
        "repository-manifest.json".into(),
        manifest_bytes(&files, context.records)?,
    );
    write_files(staged.path(), &files)?;
    verify_history(&context, &files, &context.versions)?;
    let expected = report_files(staged.path())?;
    let publication = renewal::authenticated_publication(&context, &files)?;
    if output.exists() {
        let mut actual_files = BTreeMap::new();
        collect_tree(&output, "", &mut actual_files)?;
        let mut staged_files = BTreeMap::new();
        collect_tree(staged.path(), "", &mut staged_files)?;
        if actual_files != staged_files {
            return invalid("assembled output already exists differently; never overwrite");
        }
        return Ok(KeylessAssemblyReport {
            schema_version: 1,
            changed: false,
            records: context.records,
            files: expected,
            output,
            publication,
        });
    }
    fs::rename(staged.path(), &output)?;
    Ok(KeylessAssemblyReport {
        schema_version: 1,
        changed: true,
        records: context.records,
        files: expected,
        output,
        publication,
    })
}
