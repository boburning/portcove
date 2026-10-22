use super::*;
use aws_lc_rs::rand::SystemRandom;
use tough::{
    editor::signed::SignedRole,
    key_source::KeySource,
    schema::{
        DelegatedTargets, KeyHolder, Metafile, RoleType, Snapshot, Timestamp as TufTimestamp,
    },
};
#[derive(Clone)]
struct MemoryKey(Arc<[u8]>);
impl std::fmt::Debug for MemoryKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("CatalogRoleKey([redacted])")
    }
}
#[async_trait::async_trait]
impl KeySource for MemoryKey {
    async fn as_sign(
        &self,
    ) -> std::result::Result<
        Box<dyn tough::sign::Sign>,
        Box<dyn std::error::Error + Send + Sync + 'static>,
    > {
        Ok(Box::new(tough::sign::parse_keypair(&self.0)?))
    }
    async fn write(
        &self,
        _: &str,
        _: &str,
    ) -> std::result::Result<(), Box<dyn std::error::Error + Send + Sync + 'static>> {
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "catalog in-memory key is read-only",
        )
        .into())
    }
}
async fn appointed(path: &Path, id: &[u8]) -> Result<Box<dyn KeySource>> {
    let key: Box<dyn KeySource> = Box::new(MemoryKey(io::read(path, CONFIG_MAX)?.into()));
    let public = key
        .as_sign()
        .await
        .map_err(|_| TufRepositoryError::Invalid("catalog private key malformed".into()))?
        .tuf_key();
    if !matches!(public, tough::schema::key::Key::Ed25519 { .. }) || public.key_id()?.as_ref() != id
    {
        return invalid("private key is not the exact appointed catalog role");
    }
    Ok(key)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PublicKeyInput {
    path: String,
    sha256: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Delegates {
    definitions: PublicKeyInput,
    policy: PublicKeyInput,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OfflineConfig {
    schema_version: u32,
    #[serde(default)]
    initial_root_profile: InitialRootProfile,
    generated_at: String,
    trusted_root: String,
    trusted_root_sha256: String,
    delegated_public_keys: Delegates,
    version: u64,
    expires: String,
    signing_key: String,
    output: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SignConfig {
    schema_version: u32,
    context: String,
    signing_key: String,
    signed_roles: Option<String>,
    output: String,
}
fn report(role: &str, output: PathBuf, bytes: &[u8], changed: bool) -> DefinitionRoleReport {
    DefinitionRoleReport {
        schema_version: 1,
        role: role.into(),
        changed,
        sha256: sha(bytes),
        bytes: bytes.len(),
        output,
        authority: "none",
    }
}
/// Catalog offline Targets only. It reads one Targets key after every public input passes.
pub async fn sign_offline_definition_targets(path: &Path) -> Result<DefinitionRoleReport> {
    let config_raw = io::read(path, CONFIG_MAX)?;
    let config: OfflineConfig = serde_json::from_slice(&config_raw)?;
    let at = policy::generated(config.schema_version, &config.generated_at)?;
    let base = path.parent().unwrap_or(Path::new("."));
    let root_path = io::resolve(base, &config.trusted_root)?;
    let root_bytes = io::read(&root_path, ROOT_MAX)?;
    expected(&root_bytes, &config.trusted_root_sha256)?;
    let root: Signed<Root> = serde_json::from_slice(&root_bytes)?;
    policy::root(&root, at, config.initial_root_profile)?;
    let expires = config.expires.parse::<Timestamp>().map_err(|_| {
        TufRepositoryError::Invalid("offline catalog Targets expiry malformed".into())
    })?;
    policy::window(at, expires, 90 * 86400)?;
    if config.version == 0 {
        return invalid("offline catalog Targets version is zero");
    }
    let mut keys = serde_json::Map::new();
    let mut roles = Vec::new();
    let mut readback = vec![
        (path.to_path_buf(), sha(&config_raw)),
        (root_path.clone(), sha(&root_bytes)),
    ];
    let mut inputs = vec![path.to_path_buf(), root_path];
    for (name, scope, input) in [
        (
            "official-definitions",
            vec!["definitions/index.json", "sha256/*.json"],
            &config.delegated_public_keys.definitions,
        ),
        (
            "official-policy",
            vec!["policy/official/*.json"],
            &config.delegated_public_keys.policy,
        ),
    ] {
        let public_path = io::resolve(base, &input.path)?;
        let raw = io::read(&public_path, CONFIG_MAX)?;
        expected(&raw, &input.sha256)?;
        let public: serde_json::Value = serde_json::from_slice(&raw)?;
        if public.get("keytype") != Some(&serde_json::json!("ed25519"))
            || public.get("scheme") != Some(&serde_json::json!("ed25519"))
            || public.as_object().is_none_or(|v| v.len() != 3)
            || public
                .get("keyval")
                .and_then(|v| v.as_object())
                .is_none_or(|v| v.len() != 1 || !v.contains_key("public"))
        {
            return invalid("catalog delegate requires exact public-only Ed25519 JSON");
        }
        let parsed: tough::schema::key::Key = serde_json::from_value(public.clone())?;
        let id = hex::encode(parsed.key_id()?.as_ref());
        if keys.insert(id.clone(), public).is_some() {
            return invalid("catalog delegated keys repeat");
        }
        roles.push(serde_json::json!({"name":name,"paths":scope,"keyids":[id],"threshold":1,"terminating":true}));
        readback.push((public_path.clone(), sha(&raw)));
        inputs.push(public_path);
    }
    let top: Targets = serde_json::from_value(
        serde_json::json!({"_type":"targets","spec_version":"1.0.0","version":config.version,"expires":expires,"targets":{},"delegations":{"keys":keys,"roles":roles}}),
    )?;
    // Validate delegated key separation before reading the private key. Signature is checked after signing.
    let empty = Signed {
        signed: top.clone(),
        signatures: vec![],
    };
    policy::delegations(&root.signed, &empty.signed)?;
    let private = io::resolve(base, &config.signing_key)?;
    inputs.push(private.clone());
    let output = io::resolve(base, &config.output)?;
    io::no_overlap(&output, &inputs)?;
    for (path, digest) in &readback {
        expected(&io::read(path, ROOT_MAX)?, digest)?;
    }
    let key = appointed(
        &private,
        root.signed.roles[&RoleType::Targets].keyids[0].as_ref(),
    )
    .await?;
    let signed = SignedRole::new(
        top,
        &KeyHolder::Root(root.signed.clone()),
        &[key],
        &SystemRandom::new(),
    )
    .await?;
    policy::top(&root.signed, signed.signed(), at)?;
    let bytes = io::canonical(signed.buffer())?;
    for (path, digest) in &readback {
        expected(&io::read(path, ROOT_MAX)?, digest)?;
    }
    let changed = io::write_new(&output, &bytes)?;
    Ok(report("targets", output, &bytes, changed))
}
pub(super) fn targets(context: &Context, role: DefinitionOnlineRole) -> Result<Targets> {
    let index = role.index();
    let values = context
        .targets
        .iter()
        .filter(|(name, _)| {
            if role == DefinitionOnlineRole::Definitions {
                !name.starts_with("policy/")
            } else {
                name.starts_with("policy/")
            }
        })
        .map(|(name, bytes)| {
            Ok((
                tough::TargetName::new(name.clone())?,
                serde_json::from_value(
                    serde_json::json!({"length":bytes.len(),"hashes":{"sha256":sha(bytes)}}),
                )?,
            ))
        })
        .collect::<Result<_>>()?;
    Ok(Targets {
        spec_version: "1.0.0".into(),
        version: context.versions[index],
        expires: context.expires[index],
        targets: values,
        delegations: None,
        _extra: Default::default(),
    })
}
pub(super) fn meta(bytes: &[u8], version: NonZeroU64) -> Result<Metafile> {
    Ok(serde_json::from_value(
        serde_json::json!({"version":version,"length":bytes.len(),"hashes":{"sha256":sha(bytes)}}),
    )?)
}
pub(super) fn snapshot(context: &Context, roles: &Files) -> Result<Snapshot> {
    let mut value = Snapshot::new("1.0.0".into(), context.versions[2], context.expires[2]);
    value.meta.insert(
        "targets.json".into(),
        meta(
            selected_top(context, roles)?,
            context
                .next_top
                .as_ref()
                .unwrap_or(&context.top.signed)
                .version,
        )?,
    );
    for role in [
        DefinitionOnlineRole::Definitions,
        DefinitionOnlineRole::Policy,
    ] {
        let bytes = roles
            .get(&format!("{}.json", role.name()))
            .ok_or_else(|| TufRepositoryError::Invalid("catalog signed delegate absent".into()))?;
        value.meta.insert(
            format!("{}.json", role.name()),
            meta(bytes, context.versions[role.index()])?,
        );
    }
    Ok(value)
}
pub(super) fn selected_top<'a>(context: &'a Context, roles: &'a Files) -> Result<&'a [u8]> {
    if context.next_top.is_some() {
        roles
            .get("targets.json")
            .map(Vec::as_slice)
            .ok_or_else(|| TufRepositoryError::Invalid("catalog signed Targets missing".into()))
    } else {
        Ok(&context.top_bytes)
    }
}
pub(super) fn timestamp(context: &Context, roles: &Files) -> Result<TufTimestamp> {
    let mut value = TufTimestamp::new("1.0.0".into(), context.versions[3], context.expires[3]);
    value.meta.insert(
        "snapshot.json".into(),
        meta(
            roles.get("snapshot.json").ok_or_else(|| {
                TufRepositoryError::Invalid("catalog signed snapshot absent".into())
            })?,
            context.versions[2],
        )?,
    );
    Ok(value)
}
pub(super) fn same<T: Serialize>(actual: &T, want: &T) -> Result<()> {
    if serde_json::to_value(actual)? != serde_json::to_value(want)? {
        return invalid("catalog signed body differs from exact independently expected role");
    }
    Ok(())
}
pub(super) fn roles(context: &Context, path: &Path, through: usize) -> Result<Files> {
    let count = if context.next_top.is_some() { 5 } else { 4 };
    let values = io::tree(path, count, count as u64 * ROLE_MAX)?;
    let mut allowed = vec![
        "official-definitions.json",
        "official-policy.json",
        "snapshot.json",
        "timestamp.json",
    ];
    if context.next_top.is_some() {
        allowed.push("targets.json");
    }
    if values.keys().any(|v| !allowed.contains(&v.as_str())) {
        return invalid("catalog role directory contains private/unexpected input");
    }
    let through = if values.contains_key("timestamp.json") {
        4
    } else if values.contains_key("snapshot.json") {
        3
    } else {
        through
    };
    let mut verified = Files::new();
    if let Some(expected) = &context.next_top {
        let bytes = values
            .get("targets.json")
            .ok_or_else(|| TufRepositoryError::Invalid("catalog signed Targets missing".into()))?;
        let signed: Signed<Targets> = serde_json::from_slice(bytes)?;
        policy::top(&context.root.signed, &signed, context.at)?;
        same(&signed.signed, expected)?;
        verified.insert("targets.json".into(), bytes.clone());
    }
    for role in [
        DefinitionOnlineRole::Definitions,
        DefinitionOnlineRole::Policy,
    ] {
        let name = format!("{}.json", role.name());
        let bytes = values.get(&name).ok_or_else(|| {
            TufRepositoryError::Invalid("catalog required delegate missing".into())
        })?;
        let signed: Signed<Targets> = serde_json::from_slice(bytes)?;
        context
            .top
            .signed
            .delegations
            .as_ref()
            .unwrap()
            .verify_role(&signed, role.name())?;
        if signed.signatures.len() != 1
            || signed.signatures[0].keyid.as_ref() != policy::ids(context, role)?
        {
            return invalid("catalog delegated signature inventory differs");
        }
        same(&signed.signed, &targets(context, role)?)?;
        verified.insert(name, bytes.clone());
    }
    if through >= 3 {
        let bytes = values
            .get("snapshot.json")
            .ok_or_else(|| TufRepositoryError::Invalid("catalog snapshot missing".into()))?;
        let signed: Signed<Snapshot> = serde_json::from_slice(bytes)?;
        context.root.signed.verify_role(&signed)?;
        if signed.signatures.len() != 1
            || signed.signatures[0].keyid.as_ref()
                != policy::ids(context, DefinitionOnlineRole::Snapshot)?
        {
            return invalid("catalog snapshot signature inventory differs");
        }
        same(&signed.signed, &snapshot(context, &verified)?)?;
        verified.insert("snapshot.json".into(), bytes.clone());
    }
    if through >= 4 {
        let bytes = values
            .get("timestamp.json")
            .ok_or_else(|| TufRepositoryError::Invalid("catalog timestamp missing".into()))?;
        let signed: Signed<TufTimestamp> = serde_json::from_slice(bytes)?;
        context.root.signed.verify_role(&signed)?;
        if signed.signatures.len() != 1
            || signed.signatures[0].keyid.as_ref()
                != policy::ids(context, DefinitionOnlineRole::Timestamp)?
        {
            return invalid("catalog timestamp signature inventory differs");
        }
        same(&signed.signed, &timestamp(context, &verified)?)?;
        verified.insert("timestamp.json".into(), bytes.clone());
    }
    Ok(verified)
}
/// One invocation reads exactly the selected catalog role key. Root is excluded;
/// Targets requires explicit unchanged-authority renewal with authenticated prior.
pub async fn sign_definition_role(
    role: DefinitionOnlineRole,
    path: &Path,
) -> Result<DefinitionRoleReport> {
    let config: SignConfig = io::parse(path, CONFIG_MAX)?;
    if config.schema_version != 1 {
        return invalid("catalog signer schema differs");
    }
    let base = path.parent().unwrap_or(Path::new("."));
    let context_path = io::resolve(base, &config.context)?;
    let context = load_context(&context_path).await?;
    if role == DefinitionOnlineRole::Targets && context.next_top.is_none() {
        return invalid("catalog Targets signing requires explicit online renewal mode");
    }
    let mut inputs = context.inputs.clone();
    inputs.push(path.to_path_buf());
    let required = matches!(
        role,
        DefinitionOnlineRole::Snapshot | DefinitionOnlineRole::Timestamp
    );
    if config.signed_roles.is_some() != required {
        return invalid("only snapshot/timestamp require catalog public role inputs");
    }
    let prior = if let Some(value) = &config.signed_roles {
        let directory = io::resolve(base, &value)?;
        let values = roles(
            &context,
            &directory,
            if role == DefinitionOnlineRole::Timestamp {
                3
            } else {
                2
            },
        )?;
        // The exact selected output may be a new sibling in this fixed public-role directory.
        values
    } else {
        Files::new()
    };
    let private = io::resolve(base, &config.signing_key)?;
    inputs.push(private.clone());
    let output = io::resolve(base, &config.output)?;
    io::no_overlap(&output, &inputs)?;
    // Refuse equal-version changed content before reading this sole private key.
    let unsigned = match role {
        DefinitionOnlineRole::Targets => {
            serde_json::to_value(context.next_top.as_ref().ok_or_else(|| {
                TufRepositoryError::Invalid("catalog next Targets absent".into())
            })?)?
        }
        DefinitionOnlineRole::Snapshot => serde_json::to_value(snapshot(&context, &prior)?)?,
        DefinitionOnlineRole::Timestamp => serde_json::to_value(timestamp(&context, &prior)?)?,
        _ => serde_json::to_value(targets(&context, role)?)?,
    };
    repository::check_proposed_role(
        &context,
        role,
        &serde_json::to_vec(&serde_json::json!({"signed":unsigned}))?,
    )?;
    let key = appointed(&private, &policy::ids(&context, role)?).await?;
    let rng = SystemRandom::new();
    let root_holder = KeyHolder::Root(context.root.signed.clone());
    let bytes = match role {
        DefinitionOnlineRole::Targets => SignedRole::new(
            context
                .next_top
                .clone()
                .ok_or_else(|| TufRepositoryError::Invalid("catalog next Targets absent".into()))?,
            &root_holder,
            &[key],
            &rng,
        )
        .await?
        .buffer()
        .to_vec(),
        DefinitionOnlineRole::Snapshot => {
            SignedRole::new(snapshot(&context, &prior)?, &root_holder, &[key], &rng)
                .await?
                .buffer()
                .to_vec()
        }
        DefinitionOnlineRole::Timestamp => {
            SignedRole::new(timestamp(&context, &prior)?, &root_holder, &[key], &rng)
                .await?
                .buffer()
                .to_vec()
        }
        _ => SignedRole::new(
            DelegatedTargets {
                name: role.name().into(),
                targets: targets(&context, role)?,
            },
            &KeyHolder::Delegations(context.top.signed.delegations.clone().unwrap()),
            &[key],
            &rng,
        )
        .await?
        .buffer()
        .to_vec(),
    };
    let bytes = io::canonical(&bytes)?;
    repository::check_proposed_role(&context, role, &bytes)?;
    recheck(&context)?;
    if let Some(value) = &config.signed_roles {
        if roles(
            &context,
            &io::resolve(base, value)?,
            if role == DefinitionOnlineRole::Timestamp {
                3
            } else {
                2
            },
        )? != prior
        {
            return invalid("catalog signed prerequisite inputs changed during signing");
        }
    }
    let changed = io::write_new(&output, &bytes)?;
    recheck(&context)?;
    Ok(report(role.name(), output, &bytes, changed))
}
