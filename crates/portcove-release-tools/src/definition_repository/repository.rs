use super::*;
use futures_util::TryStreamExt;
use tough::{
    RepositoryLoader, TargetName, Transport, TransportError, TransportErrorKind, TransportStream,
    schema::{Role, Snapshot, Timestamp as TufTimestamp},
};
#[derive(Debug, Clone)]
struct PublicTransport(Arc<Files>);
#[async_trait::async_trait]
impl Transport for PublicTransport {
    async fn fetch(&self, url: url::Url) -> std::result::Result<TransportStream, TransportError> {
        if url.scheme() != "https"
            || url.host_str() != Some("catalog.invalid")
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(TransportError::new(
                TransportErrorKind::UnsupportedUrlScheme,
                url.as_str(),
            ));
        }
        let bytes = self
            .0
            .get(url.path().trim_start_matches('/'))
            .cloned()
            .ok_or_else(|| TransportError::new(TransportErrorKind::FileNotFound, url.as_str()))?;
        Ok(Box::pin(futures_util::stream::iter([Ok(bytes.into())])))
    }
}
fn at<'a>(files: &'a Files, name: &str) -> Result<&'a Vec<u8>> {
    files.get(name).ok_or_else(|| {
        TufRepositoryError::Invalid(format!("catalog public repository file missing: {name}"))
    })
}
fn current_roles(files: &Files) -> Result<Files> {
    let timestamp: Signed<TufTimestamp> =
        serde_json::from_slice(at(files, "metadata/timestamp.json")?)?;
    let snapshot_version = timestamp
        .signed
        .meta
        .get("snapshot.json")
        .ok_or_else(|| TufRepositoryError::Invalid("catalog prior snapshot absent".into()))?
        .version;
    let snapshot_bytes = at(files, &format!("metadata/{snapshot_version}.snapshot.json"))?;
    let snapshot: Signed<Snapshot> = serde_json::from_slice(snapshot_bytes)?;
    if timestamp.signed.meta.len() != 1
        || timestamp.signed.spec_version != "1.0.0"
        || !timestamp.signed._extra.is_empty()
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
                "official-definitions.json",
                "official-policy.json",
            ])
    {
        return invalid("catalog prior metadata inventory/content differs");
    }
    let mut roles = Files::from([
        (
            "timestamp.json".into(),
            at(files, "metadata/timestamp.json")?.clone(),
        ),
        ("snapshot.json".into(), snapshot_bytes.clone()),
    ]);
    for role in ["targets", "official-definitions", "official-policy"] {
        let version = snapshot.signed.meta[&format!("{role}.json")].version;
        roles.insert(
            format!("{role}.json"),
            at(files, &format!("metadata/{version}.{role}.json"))?.clone(),
        );
    }
    Ok(roles)
}
async fn authenticate(root: &[u8], files: &Files) -> Result<Files> {
    let repository = RepositoryLoader::new(
        &root,
        url::Url::parse("https://catalog.invalid/metadata/").unwrap(),
        url::Url::parse("https://catalog.invalid/targets/").unwrap(),
    )
    .transport(PublicTransport(Arc::new(files.clone())))
    .limits(tough::Limits {
        max_root_size: ROOT_MAX,
        max_targets_size: ROLE_MAX,
        max_timestamp_size: ROOT_MAX,
        max_snapshot_size: 4 * 1024 * 1024,
        max_root_updates: 32,
    })
    .load()
    .await?;
    let roles = current_roles(files)?;
    let top: Signed<Targets> = serde_json::from_slice(at(&roles, "targets.json")?)?;
    if top.signed.canonical_form()? != repository.targets().signed.canonical_form()? {
        return invalid("catalog Tough loaded different top-level Targets");
    }
    let mut logical = Files::new();
    for role in ["official-definitions", "official-policy"] {
        let signed: Signed<Targets> = serde_json::from_slice(at(&roles, &format!("{role}.json"))?)?;
        if signed.signed.spec_version != "1.0.0"
            || !signed.signed._extra.is_empty()
            || signed.signed.delegations.is_some()
        {
            return invalid("catalog prior delegated metadata has unsupported content");
        }
        top.signed
            .delegations
            .as_ref()
            .ok_or_else(|| TufRepositoryError::Invalid("catalog prior delegations absent".into()))?
            .verify_role(&signed, role)?;
        for (name, target) in &signed.signed.targets {
            io::relative(name.raw())?;
            if (role == "official-definitions"
                && !(name.raw() == "definitions/index.json" || name.raw().starts_with("sha256/")))
                || (role == "official-policy" && !name.raw().starts_with("policy/official/"))
            {
                return invalid("catalog prior target outside role scope");
            }
            let maximum = if name.raw().starts_with("policy/") {
                65536
            } else {
                4 * 1024 * 1024
            };
            if target.length == 0 || target.length > maximum {
                return invalid("catalog prior target byte bound differs");
            }
            let stream = repository
                .read_target(&TargetName::new(name.raw())?)
                .await?
                .ok_or_else(|| {
                    TufRepositoryError::Invalid("catalog authenticated target absent".into())
                })?;
            let bytes = stream.map_ok(|b| b.to_vec()).try_concat().await?;
            if bytes.len() as u64 != target.length
                || sha(&bytes) != hex::encode(&target.hashes.sha256)
            {
                return invalid("catalog prior target hash/length differs");
            }
            if logical.insert(name.raw().into(), bytes).is_some() {
                return invalid("catalog prior target ownership overlap");
            }
            if logical.len() > BUNDLE_FILES
                || logical.values().map(|v| v.len() as u64).sum::<u64>() > BUNDLE_MAX
            {
                return invalid("catalog prior bundle bound exceeded");
            }
        }
    }
    Ok(logical)
}
fn validate_public_paths(files: &Files) -> Result<()> {
    for (name, bytes) in files {
        let valid = if let Some(n) = name.strip_prefix("metadata/") {
            n == "timestamp.json"
                || n.split_once('.').is_some_and(|(v, role)| {
                    v.parse::<u64>().is_ok_and(|v| v > 0)
                        && [
                            "root.json",
                            "targets.json",
                            "official-definitions.json",
                            "official-policy.json",
                            "snapshot.json",
                        ]
                        .contains(&role)
                })
        } else if let Some(n) = name.strip_prefix("targets/") {
            n.split_once('.').is_some_and(|(h, p)| {
                h.len() == 64
                    && h.bytes()
                        .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
                    && (p == "definitions/index.json"
                        || p.starts_with("sha256/")
                        || p.starts_with("policy/official/"))
            })
        } else {
            false
        };
        if name.starts_with("targets/")
            && name[8..]
                .split_once('.')
                .is_none_or(|(digest, _)| sha(bytes) != digest)
        {
            return invalid("catalog retained target hash prefix differs from actual bytes");
        }
        if !valid {
            return invalid("catalog prior tree contains foreign/private/unversioned data");
        }
    }
    Ok(())
}
pub(super) async fn inspect_prior(context: &Context, path: &Path) -> Result<Files> {
    let files = io::tree(path, 65536, 128 * 1024 * 1024)?;
    validate_public_paths(&files)?;
    let logical = authenticate(&context.root_bytes, &files).await?;
    let roles = current_roles(&files)?;
    verify_history(context, &files)?;
    let top: Signed<Targets> = serde_json::from_slice(at(&roles, "targets.json")?)?;
    policy::top(&context.root.signed, &top, context.at)?;
    if context.top.signed.version == top.signed.version
        && &context.top_bytes != at(&roles, "targets.json")?
    {
        return invalid("catalog same-version offline Targets raw envelope replacement");
    }
    if context.top.signed.version < top.signed.version
        || (context.top.signed.version == top.signed.version
            && top.signed.canonical_form()? != context.top.signed.canonical_form()?)
        || serde_json::to_value(&top.signed.delegations)?
            != serde_json::to_value(&context.top.signed.delegations)?
    {
        return invalid(
            "catalog offline Targets rollback/equivocation or unappointed delegation change",
        );
    }
    for role in [
        DefinitionOnlineRole::Definitions,
        DefinitionOnlineRole::Policy,
        DefinitionOnlineRole::Snapshot,
        DefinitionOnlineRole::Timestamp,
    ] {
        let value: serde_json::Value =
            serde_json::from_slice(at(&roles, &format!("{}.json", role.name()))?)?;
        let version = value["signed"]["version"]
            .as_u64()
            .ok_or_else(|| TufRepositoryError::Invalid("catalog prior version malformed".into()))?;
        if context.versions[role.index()].get() < version {
            return invalid("catalog proposed version rolls back authenticated floor");
        }
    }
    // Hash-addressed leaves are immutable across every retained generation.
    for (name, bytes) in &logical {
        if name.starts_with("sha256/")
            && context.targets.get(name).is_some_and(|next| next != bytes)
        {
            return invalid("catalog immutable content changed");
        }
    }
    historical_revision_floors(&files, &context.targets)?;
    Ok(files)
}
fn indexed_entries(bytes: &[u8]) -> Result<BTreeMap<(String, String), serde_json::Value>> {
    let index: serde_json::Value = serde_json::from_slice(bytes)?;
    let entries = index["definitions"].as_array().ok_or_else(|| {
        TufRepositoryError::Invalid("catalog historical index definitions absent".into())
    })?;
    if entries.len() > 4096 {
        return invalid("catalog historical index definition bound exceeded");
    }
    let mut map = BTreeMap::new();
    for entry in entries {
        let namespace = entry["namespace"].as_str().ok_or_else(|| {
            TufRepositoryError::Invalid("catalog historical namespace absent".into())
        })?;
        let id = entry["stable_id"].as_str().ok_or_else(|| {
            TufRepositoryError::Invalid("catalog historical stable id absent".into())
        })?;
        if entry["revision"].as_u64().is_none_or(|v| v == 0)
            || map
                .insert((namespace.to_owned(), id.to_owned()), entry.clone())
                .is_some()
        {
            return invalid("catalog historical definition revision/identity differs");
        }
    }
    Ok(map)
}
fn historical_revision_floors(files: &Files, new: &Files) -> Result<()> {
    let mut definitions: BTreeMap<(String, String), serde_json::Value> = BTreeMap::new();
    let mut policies: BTreeMap<String, (u64, Vec<u8>)> = BTreeMap::new();
    let mut seen = BTreeSet::new();
    for (name, bytes) in files.iter().filter(|(n, _)| {
        n.starts_with("metadata/")
            && (n.ends_with(".official-definitions.json") || n.ends_with(".official-policy.json"))
    }) {
        let role: Signed<Targets> = serde_json::from_slice(bytes)?;
        let definition_role = name.ends_with(".official-definitions.json");
        for (target, identity) in &role.signed.targets {
            if definition_role && target.raw() != "definitions/index.json" {
                continue;
            }
            if !definition_role && !target.raw().starts_with("policy/official/") {
                return invalid("catalog historical policy scope differs");
            }
            let path = format!(
                "targets/{}.{}",
                hex::encode(&identity.hashes.sha256),
                target.raw()
            );
            if !seen.insert(path.clone()) {
                continue;
            }
            let raw = at(files, &path)?;
            let maximum = if definition_role {
                4 * 1024 * 1024
            } else {
                65536
            };
            if raw.len() as u64 != identity.length
                || raw.len() > maximum
                || sha(raw) != hex::encode(&identity.hashes.sha256)
            {
                return invalid("catalog historical target identity/bound differs");
            }
            if definition_role {
                for (id, entry) in indexed_entries(raw)? {
                    if let Some(old) = definitions.get(&id) {
                        let old_revision = old["revision"].as_u64().unwrap();
                        let new_revision = entry["revision"].as_u64().unwrap();
                        if new_revision == old_revision && old != &entry {
                            return invalid("catalog retained definition history equivocates");
                        }
                        if new_revision < old_revision {
                            continue;
                        }
                    }
                    definitions.insert(id, entry);
                }
            } else {
                let policy: serde_json::Value = serde_json::from_slice(raw)?;
                let field = if target.raw().ends_with(".launch.json") {
                    "revision"
                } else {
                    "policy_revision"
                };
                let revision = policy[field].as_u64().filter(|v| *v > 0).ok_or_else(|| {
                    TufRepositoryError::Invalid(
                        "catalog historical policy/launch revision absent".into(),
                    )
                })?;
                if let Some((old_revision, old_bytes)) = policies.get(target.raw()) {
                    if revision == *old_revision && old_bytes != raw {
                        return invalid("catalog retained policy/launch history equivocates");
                    }
                    if revision < *old_revision {
                        continue;
                    }
                }
                policies.insert(target.raw().into(), (revision, raw.clone()));
            }
        }
    }
    let current = indexed_entries(at(new, "definitions/index.json")?)?;
    for (id, old) in definitions {
        if let Some(next) = current.get(&id) {
            let a = old["revision"].as_u64().unwrap();
            let b = next["revision"].as_u64().unwrap();
            if b < a || (b == a && next != &old) {
                return invalid("catalog historical definition revision rollback/equivocation");
            }
        }
    }
    for (name, (revision, bytes)) in policies {
        if let Some(next) = new.get(&name) {
            let value: serde_json::Value = serde_json::from_slice(next)?;
            let field = if name.ends_with(".launch.json") {
                "revision"
            } else {
                "policy_revision"
            };
            let next_revision = value[field].as_u64().ok_or_else(|| {
                TufRepositoryError::Invalid("catalog current policy/launch revision absent".into())
            })?;
            if next_revision < revision || (next_revision == revision && next != &bytes) {
                return invalid(
                    "catalog historical policy/launch rollback or equal-revision replacement",
                );
            }
        }
    }
    Ok(())
}
pub(super) fn check_proposed_role(
    context: &Context,
    role: DefinitionOnlineRole,
    bytes: &[u8],
) -> Result<()> {
    if context.prior.is_empty() {
        return Ok(());
    }
    let prior = current_roles(&context.prior)?;
    let old: serde_json::Value =
        serde_json::from_slice(at(&prior, &format!("{}.json", role.name()))?)?;
    let new: serde_json::Value = serde_json::from_slice(bytes)?;
    if old["signed"]["version"] == new["signed"]["version"] && old["signed"] != new["signed"] {
        return invalid("catalog same-version signed content replacement");
    }
    Ok(())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AssemblyConfig {
    schema_version: u32,
    context: String,
    signed_roles: String,
    output: String,
}
/// Keyless exact role assembly followed by Tough full target verification, with no network transport.
pub async fn assemble_definition_repository(path: &Path) -> Result<DefinitionRepositoryReport> {
    let config: AssemblyConfig = io::parse(path, CONFIG_MAX)?;
    if config.schema_version != 1 {
        return invalid("catalog assembly schema differs");
    }
    let base = path.parent().unwrap_or(Path::new("."));
    let context_path = io::resolve(base, &config.context)?;
    let context = load_context(&context_path).await?;
    let roles_path = io::resolve(base, &config.signed_roles)?;
    let roles = signing::roles(&context, &roles_path, 4)?;
    let output = io::resolve(base, &config.output)?;
    let mut inputs = context.inputs.clone();
    inputs.extend([path.to_path_buf(), roles_path]);
    io::no_overlap(&output, &inputs)?;
    let mut files = context.prior.clone();
    files.insert(
        format!("metadata/{}.root.json", context.root.signed.version),
        context.root_bytes.clone(),
    );
    files.insert(
        format!("metadata/{}.targets.json", context.top.signed.version),
        context.top_bytes.clone(),
    );
    for role in [
        DefinitionOnlineRole::Definitions,
        DefinitionOnlineRole::Policy,
        DefinitionOnlineRole::Snapshot,
        DefinitionOnlineRole::Timestamp,
    ] {
        let bytes = at(&roles, &format!("{}.json", role.name()))?;
        check_proposed_role(&context, role, bytes)?;
        let name = if role == DefinitionOnlineRole::Timestamp {
            "metadata/timestamp.json".into()
        } else {
            format!(
                "metadata/{}.{}.json",
                context.versions[role.index()],
                role.name()
            )
        };
        if let Some(old) = files.get(&name) {
            if role != DefinitionOnlineRole::Timestamp && old != bytes {
                return invalid("catalog immutable metadata history replacement");
            }
        }
        files.insert(name, bytes.clone());
    }
    for (name, bytes) in &context.targets {
        let target = TargetName::new(name.clone())?;
        let prefix = format!("targets/{}.", sha(bytes));
        let file = format!("{prefix}{}", target.raw());
        if files.get(&file).is_some_and(|v| v != bytes) {
            return invalid("catalog immutable target replacement");
        }
        files.insert(file, bytes.clone());
    }
    if files.len() > 65536
        || files.values().map(|v| v.len() as u64).sum::<u64>() > 128 * 1024 * 1024
    {
        return invalid("catalog retained public repository bound exceeded");
    }
    let logical = authenticate(&context.root_bytes, &files).await?;
    if logical != context.targets {
        return invalid("catalog full Tough readback differs from prepared bundle");
    }
    recheck(&context)?;
    if signing::roles(&context, &inputs[inputs.len() - 1], 4)? != roles {
        return invalid("catalog signed inputs changed during assembly");
    }
    let changed = if output.try_exists()? {
        if io::tree(&output, 65536, 128 * 1024 * 1024)? != files {
            return invalid("catalog assembly output exists with different bytes; retain original");
        }
        false
    } else {
        io::ancestry(
            output.parent().ok_or_else(|| {
                TufRepositoryError::Invalid("catalog output parent absent".into())
            })?,
        )?;
        let builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&output)?;
        for (name, bytes) in &files {
            let destination = output.join(name);
            fs::create_dir_all(destination.parent().unwrap())?;
            io::write_new(&destination, bytes)?;
        }
        if io::tree(&output, 65536, 128 * 1024 * 1024)? != files {
            return invalid("catalog complete assembly retained readback differs");
        }
        true
    };
    recheck(&context)?;
    let identities = bundle::identities(&files);
    let repository_sha256 = sha(&serde_json::to_vec(&identities)?);
    let actual_roles = current_roles(&files)?;
    let mut versions = BTreeMap::new();
    let mut expires = BTreeMap::new();
    for (label, name) in [
        ("targets", "targets.json"),
        ("definitions", "official-definitions.json"),
        ("policy", "official-policy.json"),
        ("snapshot", "snapshot.json"),
        ("timestamp", "timestamp.json"),
    ] {
        let signed: serde_json::Value = serde_json::from_slice(at(&actual_roles, name)?)?;
        versions.insert(
            label.into(),
            signed["signed"]["version"]
                .as_u64()
                .ok_or_else(|| {
                    TufRepositoryError::Invalid("verified metadata version absent".into())
                })?
                .to_string(),
        );
        expires.insert(
            label.into(),
            signed["signed"]["expires"]
                .as_str()
                .ok_or_else(|| {
                    TufRepositoryError::Invalid("verified metadata expiry absent".into())
                })?
                .to_owned(),
        );
    }
    Ok(DefinitionRepositoryReport {
        schema_version: 1,
        changed,
        files: identities,
        repository_sha256,
        root_sha256: sha(&context.root_bytes),
        offline_targets_sha256: sha(&context.top_bytes),
        timestamp_sha256: sha(at(&actual_roles, "timestamp.json")?),
        snapshot_sha256: sha(at(&actual_roles, "snapshot.json")?),
        versions,
        expires,
        index_sha256: context.index_sha256,
        authority: "none",
    })
}

fn verify_history(context: &Context, files: &Files) -> Result<()> {
    for (name, bytes) in files
        .iter()
        .filter(|(n, _)| n.starts_with("metadata/") && n.as_str() != "metadata/timestamp.json")
    {
        let (version, role) = name[9..].split_once('.').ok_or_else(|| {
            TufRepositoryError::Invalid("catalog metadata filename malformed".into())
        })?;
        let expected_version = version.parse::<u64>().map_err(|_| {
            TufRepositoryError::Invalid("catalog metadata filename version malformed".into())
        })?;
        let value: serde_json::Value = serde_json::from_slice(bytes)?;
        if value["signed"]["version"].as_u64() != Some(expected_version) {
            return invalid("catalog historical metadata version/path differs");
        }
        match role {
            "root.json" => {
                if bytes != &context.root_bytes {
                    return invalid("catalog routine history cannot introduce a different root");
                }
            }
            "targets.json" => {
                let signed: Signed<Targets> = serde_json::from_slice(bytes)?;
                context.root.signed.verify_role(&signed)?;
                if signed.signed.version > context.top.signed.version
                    || !signed.signed.targets.is_empty()
                    || serde_json::to_value(&signed.signed.delegations)?
                        != serde_json::to_value(&context.top.signed.delegations)?
                {
                    return invalid("catalog history has unappointed offline Targets/delegation");
                }
            }
            "snapshot.json" => {
                let signed: Signed<Snapshot> = serde_json::from_slice(bytes)?;
                context.root.signed.verify_role(&signed)?;
            }
            "official-definitions.json" | "official-policy.json" => {
                let signed: Signed<Targets> = serde_json::from_slice(bytes)?;
                context
                    .top
                    .signed
                    .delegations
                    .as_ref()
                    .unwrap()
                    .verify_role(&signed, role.trim_end_matches(".json"))?;
            }
            _ => return invalid("catalog historical metadata kind differs"),
        }
    }
    Ok(())
}
