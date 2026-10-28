//! Read-only historical public key projection. This cannot authenticate an
//! operator grant, restore a private key, rotate Root, or grant current signing.
use super::*;
use tough::schema::RoleType;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    schema_version: u32,
    initial_root_profile: InitialRootProfile,
    trusted_root: String,
    trusted_root_sha256: String,
    offline_targets: String,
    offline_targets_sha256: String,
}

#[derive(Serialize)]
pub struct CatalogRecoveryKey {
    pub role: String,
    pub key_id: String,
    pub public_key: serde_json::Value,
}

#[derive(Serialize)]
pub struct CatalogKeyInventory {
    pub schema_version: u32,
    pub operation: &'static str,
    pub initial_root_profile: InitialRootProfile,
    pub root_sha256: String,
    pub targets_sha256: String,
    pub root_version: String,
    pub targets_version: String,
    pub keys: Vec<CatalogRecoveryKey>,
    pub freshness: &'static str,
    pub authority: &'static str,
}

pub fn inspect_catalog_key_inventory(path: &Path) -> Result<CatalogKeyInventory> {
    let config: Config = io::parse(path, CONFIG_MAX)?;
    if config.schema_version != 1 {
        return invalid("catalog key inventory schema differs");
    }
    let base = path.parent().unwrap_or_else(|| Path::new("."));
    let root_bytes = io::read(&io::resolve(base, &config.trusted_root)?, ROOT_MAX)?;
    let top_bytes = io::read(&io::resolve(base, &config.offline_targets)?, ROOT_MAX)?;
    expected(&root_bytes, &config.trusted_root_sha256)?;
    expected(&top_bytes, &config.offline_targets_sha256)?;
    let root: Signed<Root> = serde_json::from_slice(&root_bytes)?;
    let top: Signed<Targets> = serde_json::from_slice(&top_bytes)?;
    policy::root_key_inventory(&root, config.initial_root_profile)?;
    policy::top_key_inventory(&root.signed, &top)?;
    let mut keys = Vec::new();
    for (role, name) in [
        (RoleType::Root, "root"),
        (RoleType::Targets, "targets"),
        (RoleType::Snapshot, "snapshot"),
        (RoleType::Timestamp, "timestamp"),
    ] {
        for id in &root.signed.roles[&role].keyids {
            let public_key = serde_json::to_value(&root.signed.keys[id])?;
            crate::tuf_repository::offline::inspect_public_key(&public_key)?;
            keys.push(CatalogRecoveryKey {
                role: format!("catalog-{name}"),
                key_id: hex::encode(id.as_ref()),
                public_key,
            });
        }
    }
    let delegations = top.signed.delegations.as_ref().ok_or_else(|| {
        TufRepositoryError::Invalid("catalog recovery delegations unavailable".into())
    })?;
    for role in &delegations.roles {
        for id in &role.keyids {
            let public_key = serde_json::to_value(&delegations.keys[id])?;
            crate::tuf_repository::offline::inspect_public_key(&public_key)?;
            keys.push(CatalogRecoveryKey {
                role: format!("catalog-{}", role.name),
                key_id: hex::encode(id.as_ref()),
                public_key,
            });
        }
    }
    Ok(CatalogKeyInventory {
        schema_version: 1,
        operation: "inspect-catalog-key-inventory",
        initial_root_profile: config.initial_root_profile,
        root_sha256: sha(&root_bytes),
        targets_sha256: sha(&top_bytes),
        root_version: root.signed.version.to_string(),
        targets_version: top.signed.version.to_string(),
        keys,
        freshness: "not-evaluated-historical-key-bindings-only",
        authority: "none",
    })
}
