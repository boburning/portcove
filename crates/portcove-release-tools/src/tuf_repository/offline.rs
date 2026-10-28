//! Initial offline custody operations. Each signing invocation reads one private
//! key; finalize reads none. These signatures do not appoint production custody
//! or authorize publication, rotation, or a different Root/Targets policy.

use super::*;
use aws_lc_rs::rand::SystemRandom;
use std::fs::OpenOptions;
use std::io::Write;
use tough::editor::signed::SignedRole;
use tough::schema::{KeyHolder, Role, Targets, key::Key};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RootConfig {
    schema_version: u32,
    #[serde(default)]
    initial_root_profile: InitialRootProfile,
    generated_at: String,
    root: String,
    signed_body_sha256: String,
    signing_key: String,
    output: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FinalizeConfig {
    schema_version: u32,
    #[serde(default)]
    initial_root_profile: InitialRootProfile,
    generated_at: String,
    root: String,
    signed_body_sha256: String,
    output: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TargetsConfig {
    schema_version: u32,
    #[serde(default)]
    initial_root_profile: InitialRootProfile,
    generated_at: String,
    trusted_root: String,
    trusted_root_sha256: String,
    payload_key_registry: String,
    payload_key_registry_sha256: String,
    delegated_public_keys: DelegatedPublicKeys,
    version: u64,
    expires: String,
    signing_key: String,
    output: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DelegatedPublicKeys {
    releases: PublicKeyInput,
    preview: PublicKeyInput,
    stable: PublicKeyInput,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct PublicKeyInput {
    path: String,
    sha256: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProposalConfig {
    schema_version: u32,
    #[serde(default)]
    initial_root_profile: InitialRootProfile,
    generated_at: String,
    expires: String,
    root_public_keys: Vec<PublicKeyInput>,
    targets_public_key: PublicKeyInput,
    snapshot_public_key: PublicKeyInput,
    timestamp_public_key: PublicKeyInput,
    output: String,
}

#[derive(Debug, Serialize)]
pub struct OfflineReport {
    pub schema_version: u32,
    pub operation: &'static str,
    pub signed_body_sha256: String,
    pub output_sha256: String,
    pub output_bytes: u64,
    pub root_quorum: bool,
    pub authority: &'static str,
}

pub(super) fn invalid<T>(message: &str) -> Result<T, TufRepositoryError> {
    Err(TufRepositoryError::Invalid(message.into()))
}

pub(crate) fn read_input(
    path: &Path,
    maximum: u64,
    _label: &str,
) -> Result<Vec<u8>, TufRepositoryError> {
    // Reject aliased ancestry as well as the leaf before the bounded existing
    // reader. Public inputs additionally have independently expected digests;
    // the one private key must derive the role's authorized public key ID.
    for ancestor in path.ancestors() {
        if ancestor.as_os_str().is_empty() {
            continue;
        }
        let metadata = fs::symlink_metadata(ancestor)?;
        if metadata.file_type().is_symlink() {
            return invalid("offline input ancestry must not contain links");
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return invalid("offline input ancestry must not contain reparse points");
            }
        }
    }
    let before = fs::symlink_metadata(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.nlink() != 1 {
            return invalid("offline input must have one link");
        }
    }
    if !before.file_type().is_file() || before.len() == 0 || before.len() > maximum {
        return invalid("offline input must be a bounded regular file");
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(0x20000 | 0x800); // O_NOFOLLOW | O_NONBLOCK
    }
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(0x100 | 0x4); // O_NOFOLLOW | O_NONBLOCK
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000).share_mode(1); // reparse-point open; FILE_SHARE_READ only
    }
    let mut file = options.open(path)?;
    let held = file.metadata()?;
    if !held.file_type().is_file() || held.len() != before.len() {
        return invalid("offline opened input kind or length changed");
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if held.file_attributes() & 0x400 != 0 || windows_link_count(&file)? != 1 {
            return invalid("offline opened input is a reparse point or has multiple links");
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if held.nlink() != 1 || (before.dev(), before.ino()) != (held.dev(), held.ino()) {
            return invalid("offline opened input identity changed");
        }
    }
    let mut bytes = Vec::with_capacity(held.len() as usize);
    (&mut file).take(maximum + 1).read_to_end(&mut bytes)?;
    if bytes.is_empty() || bytes.len() as u64 > maximum {
        return invalid("offline opened input grew beyond its byte limit");
    }
    let final_held = file.metadata()?;
    #[cfg(windows)]
    if windows_link_count(&file)? != 1 {
        return invalid("offline held input link count changed");
    }
    if final_held.len() != held.len() || final_held.modified()? != held.modified()? {
        return invalid("offline held input changed during bounded read");
    }
    let after = fs::symlink_metadata(path)?;
    if !after.file_type().is_file()
        || before.len() != after.len()
        || before.modified()? != after.modified()?
        || bytes.len() as u64 != after.len()
    {
        return invalid("offline input changed during bounded read");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if (
            before.dev(),
            before.ino(),
            before.ctime(),
            before.ctime_nsec(),
        ) != (after.dev(), after.ino(), after.ctime(), after.ctime_nsec())
        {
            return invalid("offline input identity changed during bounded read");
        }
    }
    Ok(bytes)
}

#[cfg(windows)]
fn windows_link_count(file: &fs::File) -> Result<u32, TufRepositoryError> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
    };
    // SAFETY: output is initialized, correctly sized, and the borrowed file
    // handle remains open throughout the synchronous call.
    let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut information) } == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(information.nNumberOfLinks)
}

fn parse<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, TufRepositoryError> {
    Ok(serde_json::from_slice(&read_input(
        path,
        MAX_CONFIG_BYTES,
        "offline config",
    )?)?)
}

fn parse_root(bytes: &[u8]) -> Result<Signed<Root>, TufRepositoryError> {
    let value: serde_json::Value = serde_json::from_slice(bytes)?;
    let envelope = value
        .as_object()
        .ok_or_else(|| TufRepositoryError::Invalid("Root envelope must be an object".into()))?;
    if envelope.keys().map(String::as_str).collect::<BTreeSet<_>>()
        != BTreeSet::from(["signed", "signatures"])
    {
        return invalid("Root envelope has unexpected fields");
    }
    let signatures = value["signatures"]
        .as_array()
        .ok_or_else(|| TufRepositoryError::Invalid("Root signatures must be an array".into()))?;
    for signature in signatures {
        if signature.as_object().is_none_or(|object| {
            object.keys().map(String::as_str).collect::<BTreeSet<_>>()
                != BTreeSet::from(["keyid", "sig"])
        }) {
            return invalid("Root signature has unexpected fields");
        }
    }
    let keys = value["signed"]["keys"]
        .as_object()
        .ok_or_else(|| TufRepositoryError::Invalid("Root public keys must be an object".into()))?;
    for key in keys.values() {
        inspect_public_key(key)?;
    }
    // Keep exact raw-byte struct parsing consistent with downstream Tough.
    // Value inspection above must not collapse a duplicate Root struct field.
    Ok(serde_json::from_slice(bytes)?)
}

fn generated(schema: u32, text: &str) -> Result<Timestamp, TufRepositoryError> {
    let value = expiration(text, "offline generation")?;
    if schema != 1
        || value
            > Timestamp::now()
                .checked_add(Duration::from_secs(300))
                .map_err(|_| TufRepositoryError::Invalid("offline generation overflow".into()))?
    {
        return invalid("offline schema or generation time differs");
    }
    Ok(value)
}

fn expected(bytes: &[u8], digest: &str) -> Result<(), TufRepositoryError> {
    lowercase_sha256(digest, "expected public input digest")?;
    if sha256(bytes) != digest {
        return invalid("offline public input differs from its independently expected digest");
    }
    Ok(())
}

pub(super) fn public_key(base: &Path, input: &PublicKeyInput) -> Result<Key, TufRepositoryError> {
    let bytes = read_input(
        &resolve(base, &input.path, "public key")?,
        MAX_CONFIG_BYTES,
        "public key",
    )?;
    expected(&bytes, &input.sha256)?;
    let value: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|_| TufRepositoryError::Invalid("public key must be public TUF JSON".into()))?;
    inspect_public_key(&value)?;
    serde_json::from_value(value)
        .map_err(|_| TufRepositoryError::Invalid("public TUF key encoding is invalid".into()))
}

pub(crate) fn inspect_public_key(value: &serde_json::Value) -> Result<(), TufRepositoryError> {
    if value["keytype"] != "ed25519"
        || value["scheme"] != "ed25519"
        || value["keyval"]["public"].as_str().is_none_or(|public| {
            public.len() != 64
                || !public
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
    {
        return invalid("offline roles require a canonical 32-byte Ed25519 public key");
    }
    let object = value.as_object().ok_or_else(|| {
        TufRepositoryError::Invalid("public key must be a public TUF object".into())
    })?;
    if object.keys().map(String::as_str).collect::<BTreeSet<_>>()
        != BTreeSet::from(["keytype", "scheme", "keyval"])
        || object
            .get("keyval")
            .and_then(serde_json::Value::as_object)
            .is_none_or(|keyval| keyval.len() != 1 || !keyval.contains_key("public"))
    {
        return invalid("public key must contain only the public TUF key fields");
    }
    Ok(())
}

/// Prepare only public initial Root data. Key IDs and the approved-body digest
/// derive from digest-bound public files; no private key is read or generated.
pub fn prepare_initial_root(path: &Path) -> Result<OfflineReport, TufRepositoryError> {
    let config: ProposalConfig = parse(path)?;
    let at = generated(config.schema_version, &config.generated_at)?;
    if config.root_public_keys.len() != config.initial_root_profile.root_keys() {
        return invalid("initial Root public key count differs from the configured profile");
    }
    let base = path.parent().unwrap_or_else(|| Path::new("."));
    let mut keys = serde_json::Map::new();
    let mut roles = serde_json::Map::new();
    let mut root_ids = Vec::new();
    for input in &config.root_public_keys {
        let key = public_key(base, input)?;
        let id = hex::encode(key.key_id()?.as_ref());
        if keys
            .insert(id.clone(), serde_json::to_value(key)?)
            .is_some()
        {
            return invalid("initial Root public keys must be distinct");
        }
        root_ids.push(id);
    }
    roles.insert(
        "root".into(),
        serde_json::json!({"keyids":root_ids,"threshold":config.initial_root_profile.threshold()}),
    );
    for (name, input) in [
        ("targets", &config.targets_public_key),
        ("snapshot", &config.snapshot_public_key),
        ("timestamp", &config.timestamp_public_key),
    ] {
        let key = public_key(base, input)?;
        let id = hex::encode(key.key_id()?.as_ref());
        if keys
            .insert(id.clone(), serde_json::to_value(key)?)
            .is_some()
        {
            return invalid("initial Root roles must have distinct public keys");
        }
        roles.insert(
            name.into(),
            serde_json::json!({"keyids":[id],"threshold":1}),
        );
    }
    let root: Root = serde_json::from_value(serde_json::json!({
        "_type":"root","spec_version":"1.0.0","version":1,"consistent_snapshot":true,
        "expires":expiration(&config.expires,"initial Root")?,"keys":keys,"roles":roles
    }))?;
    root_policy(&root, at, config.initial_root_profile)?;
    let body = root.canonical_form()?;
    let mut bytes = serde_json::to_vec_pretty(&Signed {
        signed: root,
        signatures: Vec::new(),
    })?;
    bytes.push(b'\n');
    write_new(
        &resolve(base, &config.output, "initial Root proposal")?,
        &bytes,
        &body,
        "initial-root-public-proposal",
        false,
    )
}

fn root_policy(
    root: &Root,
    at: Timestamp,
    profile: InitialRootProfile,
) -> Result<[Vec<u8>; 6], TufRepositoryError> {
    if root.version != NonZeroU64::MIN
        || root.spec_version != "1.0.0"
        || !root._extra.is_empty()
        || root.roles.len() != 4
        || root.keys.len() != profile.root_keys() + 3
    {
        return invalid("offline ceremony accepts only the fixed initial Root v1");
    }
    let roots = root
        .roles
        .get(&RoleType::Root)
        .ok_or_else(|| TufRepositoryError::Invalid("initial Root role is absent".into()))?;
    if roots.keyids.len() != profile.root_keys()
        || roots.keyids.iter().collect::<BTreeSet<_>>().len() != profile.root_keys()
    {
        return invalid(
            "initial Root distinct public key count differs from the configured profile",
        );
    }
    let mut ids: [Vec<u8>; 6] = Default::default();
    let mut assigned = roots.keyids.iter().cloned().collect::<BTreeSet<_>>();
    for (index, role) in [RoleType::Targets, RoleType::Snapshot, RoleType::Timestamp]
        .into_iter()
        .enumerate()
    {
        let definition = root.roles.get(&role).ok_or_else(|| {
            TufRepositoryError::Invalid("initial Root omits a required role".into())
        })?;
        if definition.keyids.len() != 1 || !assigned.insert(definition.keyids[0].clone()) {
            return invalid("initial Root roles must have separate public keys");
        }
        ids[index] = definition.keyids[0].to_vec();
    }
    if assigned != root.keys.keys().cloned().collect()
        || root.roles.values().any(|role| !role._extra.is_empty())
    {
        return invalid("initial Root public key inventory or role extensions differ");
    }
    for (id, key) in &root.keys {
        inspect_public_key(&serde_json::to_value(key)?)?;
        if key.key_id()? != *id {
            return invalid("Root key ID does not match its public key bytes");
        }
    }
    validate_root_contract(root, at, Timestamp::now(), &ids, profile)?;
    Ok(ids)
}

fn check_partial(root: &Signed<Root>) -> Result<(), TufRepositoryError> {
    let keys = &root.signed.roles[&RoleType::Root].keyids;
    let mut seen = BTreeSet::new();
    // This verifier-only projection checks each signature on the ORIGINAL
    // body's canonical bytes. It is never serialized or returned as a Root.
    let mut verifier = root.signed.clone();
    verifier.roles.get_mut(&RoleType::Root).unwrap().threshold = NonZeroU64::MIN;
    for signature in &root.signatures {
        if !keys.contains(&signature.keyid) || !seen.insert(signature.keyid.clone()) {
            return invalid("Root partial contains a duplicate or non-root signer");
        }
        verifier.verify_role(&Signed {
            signed: root.signed.clone(),
            signatures: vec![signature.clone()],
        })?;
    }
    Ok(())
}

fn write_new(
    output: &Path,
    bytes: &[u8],
    body: &[u8],
    operation: &'static str,
    root_quorum: bool,
) -> Result<OfflineReport, TufRepositoryError> {
    if bytes.is_empty() || bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return invalid("offline output exceeds its bounded metadata limit");
    }
    let parent = output
        .parent()
        .ok_or_else(|| TufRepositoryError::Invalid("offline output has no parent".into()))?;
    for ancestor in parent.ancestors() {
        if ancestor.as_os_str().is_empty() {
            continue;
        }
        let metadata = fs::symlink_metadata(ancestor)?;
        if metadata.file_type().is_symlink() {
            return invalid("offline output ancestry must not contain links");
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return invalid("offline output ancestry must not contain reparse points");
            }
        }
    }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    // No replacement or automatic retry. Failed/partial output is retained.
    let mut file = options.open(output)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    #[cfg(unix)]
    fs::File::open(parent)?.sync_all()?;
    drop(file);
    if read_input(output, MAX_MANIFEST_BYTES, "offline output readback")? != bytes {
        return invalid("offline output readback differs");
    }
    Ok(OfflineReport {
        schema_version: 1,
        operation,
        signed_body_sha256: sha256(body),
        output_sha256: sha256(bytes),
        output_bytes: bytes.len() as u64,
        root_quorum,
        authority: "none",
    })
}

/// Add exactly one distinct authorized Root signature, without collecting any
/// other private key. The original body must match the explicitly selected profile.
pub async fn sign_initial_root(path: &Path) -> Result<OfflineReport, TufRepositoryError> {
    let config: RootConfig = parse(path)?;
    let at = generated(config.schema_version, &config.generated_at)?;
    let base = path.parent().unwrap_or_else(|| Path::new("."));
    let input = resolve(base, &config.root, "initial Root")?;
    let root = parse_root(&read_input(&input, MAX_MANIFEST_BYTES, "initial Root")?)?;
    root_policy(&root.signed, at, config.initial_root_profile)?;
    let body = root.signed.canonical_form()?;
    expected(&body, &config.signed_body_sha256)?;
    check_partial(&root)?;
    if root.signatures.len() as u64 >= config.initial_root_profile.threshold() {
        return invalid("initial Root already has a complete quorum; finalize it without a key");
    }
    let key_path = resolve(base, &config.signing_key, "one offline Root key")?;
    let key = key(Arc::from(read_input(
        &key_path,
        MAX_CONFIG_BYTES,
        "one offline Root key",
    )?));
    let public = key
        .as_sign()
        .await
        .map_err(|_| TufRepositoryError::Invalid("offline key cannot be parsed".into()))?
        .tuf_key();
    let id = public.key_id()?;
    if !root.signed.roles[&RoleType::Root].keyids.contains(&id)
        || root
            .signatures
            .iter()
            .any(|signature| signature.keyid == id)
    {
        return invalid("one new distinct Root key is required");
    }
    let signed = SignedRole::new(
        root.signed.clone(),
        &KeyHolder::Root(root.signed.clone()),
        &[key],
        &SystemRandom::new(),
    )
    .await?
    .add_old_signatures(root.signatures)?;
    check_partial(signed.signed())?;
    if signed.signed().signed.canonical_form()? != body {
        return invalid("Root signature merge changed the approved body");
    }
    let complete =
        signed.signed().signatures.len() as u64 == config.initial_root_profile.threshold();
    if complete {
        signed.signed().signed.verify_role(signed.signed())?;
    }
    write_new(
        &resolve(base, &config.output, "Root partial output")?,
        signed.buffer(),
        &body,
        "initial-root-partial",
        complete,
    )
}

/// Validate and retain the original complete Root, using no private key.
pub fn finalize_initial_root(path: &Path) -> Result<OfflineReport, TufRepositoryError> {
    let config: FinalizeConfig = parse(path)?;
    let at = generated(config.schema_version, &config.generated_at)?;
    let base = path.parent().unwrap_or_else(|| Path::new("."));
    let bytes = read_input(
        &resolve(base, &config.root, "Root quorum input")?,
        MAX_MANIFEST_BYTES,
        "Root quorum",
    )?;
    let root = parse_root(&bytes)?;
    root_policy(&root.signed, at, config.initial_root_profile)?;
    let body = root.signed.canonical_form()?;
    expected(&body, &config.signed_body_sha256)?;
    check_partial(&root)?;
    root.signed.verify_role(&root)?;
    write_new(
        &resolve(base, &config.output, "Root output")?,
        &bytes,
        &body,
        "initial-root-finalize",
        true,
    )
}

/// Sign the fixed initial top-level Targets with ONLY its offline private key.
/// All three delegated keys, Root and payload registry are public inputs.
pub async fn sign_initial_targets(path: &Path) -> Result<OfflineReport, TufRepositoryError> {
    let config: TargetsConfig = parse(path)?;
    let at = generated(config.schema_version, &config.generated_at)?;
    if config.version != 1 {
        return invalid("initial offline Targets version must be one");
    }
    let expires = expiration(&config.expires, "offline Targets")?;
    expiry_window(
        at,
        Timestamp::now(),
        expires,
        Duration::from_secs(90 * 86400),
        "offline Targets",
    )?;
    let base = path.parent().unwrap_or_else(|| Path::new("."));
    let root_path = resolve(base, &config.trusted_root, "trusted initial Root")?;
    let root_bytes = read_input(&root_path, MAX_MANIFEST_BYTES, "trusted initial Root")?;
    expected(&root_bytes, &config.trusted_root_sha256)?;
    let root = parse_root(&root_bytes)?;
    let mut ids = root_policy(&root.signed, at, config.initial_root_profile)?;
    check_partial(&root)?;
    root.signed.verify_role(&root)?;
    let registry_path = resolve(base, &config.payload_key_registry, "payload registry")?;
    let registry = read_input(&registry_path, MAX_REGISTRY_BYTES, "payload registry")?;
    expected(&registry, &config.payload_key_registry_sha256)?;
    validate_payload_registry(&registry)?;
    let mut keys = serde_json::Map::new();
    let mut roles = Vec::new();
    let mut unique = root.signed.keys.keys().cloned().collect::<BTreeSet<_>>();
    for (index, (role, input)) in [
        (
            DelegatedRole::Releases,
            &config.delegated_public_keys.releases,
        ),
        (
            DelegatedRole::Preview,
            &config.delegated_public_keys.preview,
        ),
        (DelegatedRole::Stable, &config.delegated_public_keys.stable),
    ]
    .into_iter()
    .enumerate()
    {
        let public = public_key(base, input)?;
        let id = public.key_id()?;
        if !unique.insert(id.clone()) {
            return invalid("offline and online public keys must be distinct");
        }
        ids[index + 3] = id.to_vec();
        let id = hex::encode(id.as_ref());
        keys.insert(id.clone(), serde_json::to_value(public)?);
        roles.push(serde_json::json!({"name":role.name(),"keyids":[id],"threshold":1,"terminating":true,"paths":role.namespace_patterns()}));
    }
    let top: Targets = serde_json::from_value(serde_json::json!({
        "_type":"targets","spec_version":"1.0.0","version":1,"expires":expires,
        "targets":{"keys/payload.json":{"length":registry.len(),"hashes":{"sha256":sha256(&registry)}}},
        "delegations":{"keys":keys,"roles":roles}
    }))?;
    let key_path = resolve(base, &config.signing_key, "one offline Targets key")?;
    let key = key(Arc::from(read_input(
        &key_path,
        MAX_CONFIG_BYTES,
        "one offline Targets key",
    )?));
    let signed = SignedRole::new(
        top,
        &KeyHolder::Root(root.signed.clone()),
        &[key],
        &SystemRandom::new(),
    )
    .await?;
    root.signed.verify_role(signed.signed())?;
    let output = resolve(base, &config.output, "offline Targets output")?;
    let body = signed.signed().signed.canonical_form()?;
    let report = write_new(
        &output,
        signed.buffer(),
        &body,
        "initial-offline-targets",
        true,
    )?;
    let versions = [NonZeroU64::MIN; 6];
    let expirations = [expires; 6];
    // Reuse the same complete namespace/key/payload contract as bootstrap.
    online::load_offline_targets(&output, &root, &ids, &versions, &expirations, &registry)?;
    Ok(report)
}
