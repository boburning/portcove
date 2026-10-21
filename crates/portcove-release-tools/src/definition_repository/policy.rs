use super::*;
use tough::schema::{PathSet, RoleType};
pub(super) fn generated(schema: u32, value: &str) -> Result<Timestamp> {
    let at = value
        .parse::<Timestamp>()
        .map_err(|_| TufRepositoryError::Invalid("catalog generation time malformed".into()))?;
    let now = Timestamp::now();
    if schema != 1
        || at
            > now
                .checked_add(Duration::from_secs(300))
                .map_err(|_| TufRepositoryError::Invalid("time overflow".into()))?
        || at
            < now
                .checked_sub(Duration::from_secs(300))
                .map_err(|_| TufRepositoryError::Invalid("time overflow".into()))?
    {
        return invalid("catalog generation time must be current within five minutes");
    }
    Ok(at)
}
pub(super) fn window(at: Timestamp, expires: Timestamp, seconds: u64) -> Result<()> {
    if expires <= at
        || expires <= Timestamp::now()
        || expires
            > at.checked_add(Duration::from_secs(seconds))
                .map_err(|_| TufRepositoryError::Invalid("catalog expiry overflow".into()))?
    {
        return invalid("catalog expiration exceeds its role ceiling or is expired");
    }
    Ok(())
}
pub(super) fn root(root: &Signed<Root>, at: Timestamp) -> Result<()> {
    if root.signed.spec_version != "1.0.0"
        || !root.signed.consistent_snapshot
        || !root.signed._extra.is_empty()
        || root.signed.roles.len() != 4
        || root.signed.keys.len() != 6
    {
        return invalid("catalog Root requires exact consistent-snapshot role inventory");
    }
    window(at, root.signed.expires, 365 * 86400)?;
    let mut ids = BTreeSet::new();
    let mut materials = BTreeSet::new();
    for role in [
        RoleType::Root,
        RoleType::Targets,
        RoleType::Snapshot,
        RoleType::Timestamp,
    ] {
        let r = root
            .signed
            .roles
            .get(&role)
            .ok_or_else(|| TufRepositoryError::Invalid("catalog Root role missing".into()))?;
        let (count, threshold) = if role == RoleType::Root {
            (3, 2)
        } else {
            (1, 1)
        };
        if r.keyids.len() != count || r.threshold.get() != threshold {
            return invalid("catalog Root requires two-of-three and distinct one-key roles");
        }
        for id in &r.keyids {
            let public = root
                .signed
                .keys
                .get(id)
                .ok_or_else(|| TufRepositoryError::Invalid("catalog Root key absent".into()))?;
            if !matches!(public, tough::schema::key::Key::Ed25519 { .. })
                || public.key_id()? != *id
                || !ids.insert(id.clone())
                || !materials.insert(serde_json::to_vec(public)?)
            {
                return invalid("catalog Root keys are not distinct exact Ed25519 identities");
            }
        }
    }
    let root_ids = &root.signed.roles[&RoleType::Root].keyids;
    let mut seen = BTreeSet::new();
    if root.signatures.len() < 2
        || root.signatures.len() > 3
        || root
            .signatures
            .iter()
            .any(|s| !root_ids.contains(&s.keyid) || !seen.insert(s.keyid.clone()))
    {
        return invalid("catalog Root signature inventory differs");
    }
    root.signed.verify_role(root)?;
    Ok(())
}
pub(super) fn top(root: &Root, top: &Signed<Targets>, at: Timestamp) -> Result<()> {
    root.verify_role(top)?;
    if top.signatures.len() != 1
        || top.signatures[0].keyid != root.roles[&RoleType::Targets].keyids[0]
        || top.signed.spec_version != "1.0.0"
        || !top.signed._extra.is_empty()
        || !top.signed.targets.is_empty()
    {
        return invalid("catalog offline Targets must only delegate with its appointed key");
    }
    window(at, top.signed.expires, 90 * 86400)?;
    delegations(root, &top.signed)
}
pub(super) fn delegations(root: &Root, top: &Targets) -> Result<()> {
    let d = top
        .delegations
        .as_ref()
        .ok_or_else(|| TufRepositoryError::Invalid("catalog delegations absent".into()))?;
    if d.roles.len() != 2 || d.keys.len() != 2 {
        return invalid("catalog requires exact definitions/policy delegates");
    }
    let mut ids = root.keys.keys().cloned().collect::<BTreeSet<_>>();
    let mut materials = root
        .keys
        .values()
        .map(serde_json::to_vec)
        .collect::<std::result::Result<BTreeSet<_>, _>>()?;
    for (index, (name, paths)) in [
        (
            "official-definitions",
            vec!["definitions/index.json", "sha256/*.json"],
        ),
        ("official-policy", vec!["policy/official/*.json"]),
    ]
    .into_iter()
    .enumerate()
    {
        let r = &d.roles[index];
        let actual = match &r.paths {
            PathSet::Paths(v) => v.iter().map(|p| p.value()).collect::<BTreeSet<_>>(),
            _ => return invalid("catalog delegation hash-prefix scope unsupported"),
        };
        if r.name != name
            || !r.terminating
            || r.threshold != NonZeroU64::MIN
            || r.keyids.len() != 1
            || actual != paths.into_iter().collect()
        {
            return invalid("catalog delegation order/name/terminating/paths differ");
        }
        let id = &r.keyids[0];
        let public = d
            .keys
            .get(id)
            .ok_or_else(|| TufRepositoryError::Invalid("catalog delegated key absent".into()))?;
        if !matches!(public, tough::schema::key::Key::Ed25519 { .. })
            || public.key_id()? != *id
            || !ids.insert(id.clone())
            || !materials.insert(serde_json::to_vec(public)?)
        {
            return invalid(
                "catalog delegated keys must be separate from every root/top-level key",
            );
        }
    }
    Ok(())
}
pub(super) fn ids(context: &Context, role: DefinitionOnlineRole) -> Result<Vec<u8>> {
    let id = match role {
        DefinitionOnlineRole::Snapshot => &context.root.signed.roles[&RoleType::Snapshot].keyids[0],
        DefinitionOnlineRole::Timestamp => {
            &context.root.signed.roles[&RoleType::Timestamp].keyids[0]
        }
        _ => {
            &context
                .top
                .signed
                .delegations
                .as_ref()
                .ok_or_else(|| TufRepositoryError::Invalid("delegations absent".into()))?
                .roles[role.index()]
            .keyids[0]
        }
    };
    Ok(id.to_vec())
}
