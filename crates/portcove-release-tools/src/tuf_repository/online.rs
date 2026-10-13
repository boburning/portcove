//! Routine role signing consumes immutable, authenticated offline targets.

use super::*;
use aws_lc_rs::rand::SystemRandom;
use std::collections::HashMap;
use tough::editor::signed::SignedRole;
use tough::schema::{DelegatedTargets, KeyHolder, Metafile, Snapshot, Targets};

fn metadata_identity(bytes: &[u8], version: NonZeroU64) -> Result<Metafile, TufRepositoryError> {
    Ok(serde_json::from_value(serde_json::json!({
        "version": version, "length": bytes.len(), "hashes": {"sha256": sha256(bytes)}
    }))?)
}

pub(super) fn load_offline_targets(
    offline_path: &Path,
    root: &Signed<Root>,
    key_ids: &[Vec<u8>; 6],
    versions: &[NonZeroU64; 6],
    expirations: &[Timestamp; 6],
    registry: &[u8],
) -> Result<(Vec<u8>, Signed<Targets>), TufRepositoryError> {
    let bytes = read_regular_bounded(offline_path, MAX_MANIFEST_BYTES, "offline targets")?;
    let top: Signed<Targets> = serde_json::from_slice(&bytes)?;
    root.signed.verify_role(&top)?;
    if top.signed.version != versions[0]
        || top.signed.expires != expirations[0]
        || top.signed.spec_version != "1.0.0"
        || !top.signed._extra.is_empty()
    {
        return Err(TufRepositoryError::Invalid(
            "offline targets identity or policy differs".into(),
        ));
    }
    let names: BTreeSet<_> = top.signed.targets.keys().map(|name| name.raw()).collect();
    let registry_name = TargetName::new("keys/payload.json")?;
    if names != BTreeSet::from(["keys/payload.json"]) {
        return Err(TufRepositoryError::Invalid(
            "offline payload registry inventory differs".into(),
        ));
    }
    let expected_registry =
        top.signed.targets.get(&registry_name).ok_or_else(|| {
            TufRepositoryError::Invalid("offline payload registry is absent".into())
        })?;
    if expected_registry.length != registry.len() as u64
        || expected_registry.hashes.sha256.as_ref() != Sha256::digest(registry).as_slice()
        || !expected_registry._extra.is_empty()
        || !expected_registry.hashes._extra.is_empty()
    {
        return Err(TufRepositoryError::Invalid(
            "offline payload registry bytes differ".into(),
        ));
    }
    let delegations = top
        .signed
        .delegations
        .as_ref()
        .ok_or_else(|| TufRepositoryError::Invalid("offline delegations are absent".into()))?;
    let names: BTreeSet<_> = delegations
        .roles
        .iter()
        .map(|role| role.name.as_str())
        .collect();
    let ids: BTreeSet<_> = delegations.keys.keys().map(|id| id.to_vec()).collect();
    if delegations.roles.len() != 3
        || names != BTreeSet::from(["releases", "preview", "stable"])
        || ids != key_ids[3..].iter().cloned().collect()
    {
        return Err(TufRepositoryError::Invalid(
            "offline delegated key or role inventory differs".into(),
        ));
    }
    for (role, index) in [
        (DelegatedRole::Releases, 3),
        (DelegatedRole::Preview, 4),
        (DelegatedRole::Stable, 5),
    ] {
        let definition = delegations
            .roles
            .iter()
            .find(|value| value.name == role.name())
            .ok_or_else(|| TufRepositoryError::Invalid("offline role is absent".into()))?;
        let patterns: BTreeSet<_> = match &definition.paths {
            PathSet::Paths(paths) => paths.iter().map(|path| path.value()).collect(),
            PathSet::PathHashPrefixes(_) => {
                return Err(TufRepositoryError::Invalid(
                    "offline hashed paths are unsupported".into(),
                ));
            }
        };
        if patterns != role.namespace_patterns().into_iter().collect()
            || definition.threshold != NonZeroU64::MIN
            || !definition.terminating
            || definition.keyids.len() != 1
            || definition.keyids[0].as_ref() != key_ids[index].as_slice()
        {
            return Err(TufRepositoryError::Invalid(
                "offline delegation policy differs".into(),
            ));
        }
    }
    Ok((bytes, top))
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn write_online_repository(
    offline_targets: &(Vec<u8>, Signed<Targets>),
    root: &Signed<Root>,
    keys: &[Arc<[u8]>; 6],
    versions: &[NonZeroU64; 6],
    expirations: &[Timestamp; 6],
    records: &[(RecordIdentity, DelegatedRole, Vec<u8>)],
    target_root: &Path,
    metadata_root: &Path,
) -> Result<(), TufRepositoryError> {
    let (bytes, top) = offline_targets;
    let delegations = top
        .signed
        .delegations
        .as_ref()
        .ok_or_else(|| TufRepositoryError::Invalid("offline delegations are absent".into()))?;
    let mut snapshot = Snapshot::new("1.0.0".into(), versions[1], expirations[1]);
    snapshot.meta.insert(
        "targets.json".into(),
        metadata_identity(bytes, versions[0])?,
    );
    let holder = KeyHolder::Delegations(delegations.clone());
    let rng = SystemRandom::new();
    for (role, index) in [
        (DelegatedRole::Releases, 3),
        (DelegatedRole::Preview, 4),
        (DelegatedRole::Stable, 5),
    ] {
        let mut targets = Targets {
            spec_version: "1.0.0".into(),
            version: versions[index],
            expires: expirations[index],
            targets: HashMap::new(),
            delegations: None,
            _extra: HashMap::new(),
        };
        for record in role_records(records, role) {
            let (_, target) =
                RepositoryEditor::build_target(target_root.join(&record.path)).await?;
            targets
                .targets
                .insert(TargetName::new(&record.path)?, target);
        }
        let signed = SignedRole::new(
            DelegatedTargets {
                name: role.name().into(),
                targets,
            },
            &holder,
            &[key(keys[index].clone())],
            &rng,
        )
        .await?;
        let name = format!("{}.json", role.name());
        snapshot
            .meta
            .insert(name, metadata_identity(signed.buffer(), versions[index])?);
        fs::write(
            metadata_root.join(format!("{}.{}.json", versions[index], role.name())),
            signed.buffer(),
        )?;
    }
    let root_holder = KeyHolder::Root(root.signed.clone());
    let snapshot = SignedRole::new(snapshot, &root_holder, &[key(keys[1].clone())], &rng).await?;
    let mut timestamp = tough::schema::Timestamp::new("1.0.0".into(), versions[2], expirations[2]);
    timestamp.meta.insert(
        "snapshot.json".into(),
        metadata_identity(snapshot.buffer(), versions[1])?,
    );
    let timestamp = SignedRole::new(timestamp, &root_holder, &[key(keys[2].clone())], &rng).await?;
    fs::write(
        metadata_root.join(format!("{}.targets.json", versions[0])),
        bytes,
    )?;
    fs::write(
        metadata_root.join(format!("{}.snapshot.json", versions[1])),
        snapshot.buffer(),
    )?;
    fs::write(metadata_root.join("timestamp.json"), timestamp.buffer())?;
    Ok(())
}
