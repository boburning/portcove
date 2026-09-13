use std::collections::HashMap;
use std::fs;
use std::num::NonZeroU64;
use std::path::{Path, PathBuf};
use std::time::Duration;

use aws_lc_rs::{rand::SystemRandom, signature::Ed25519KeyPair};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use jiff::Timestamp;
use serde_json::json;
use sha2::{Digest, Sha256};
use tough::editor::signed::SignedRole;
use tough::key_source::{KeySource, LocalKeySource};
use tough::schema::{KeyHolder, RoleKeys, RoleType, Root};

type AnyError = Box<dyn std::error::Error + Send + Sync>;

fn key(path: PathBuf) -> Box<dyn KeySource> {
    Box::new(LocalKeySource { path })
}

#[derive(Clone)]
struct TestKey(PathBuf);

impl TestKey {
    fn generate(directory: &Path, name: &str) -> Result<Self, AnyError> {
        let bytes = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
            .map_err(|_| "could not generate a disposable Ed25519 key")?;
        let path = directory.join(name);
        fs::write(&path, bytes.as_ref())?;
        Ok(Self(path))
    }

    fn source(&self) -> Box<dyn KeySource> {
        key(self.0.clone())
    }
}

async fn write_root(
    destination: &Path,
    offline: &[TestKey],
    top_level: &[TestKey],
) -> Result<(), AnyError> {
    let mut root = Root {
        spec_version: "1.0.0".into(),
        consistent_snapshot: true,
        version: NonZeroU64::MIN,
        expires: Timestamp::now().checked_add(Duration::from_secs(300 * 86_400))?,
        keys: HashMap::new(),
        roles: HashMap::new(),
        _extra: HashMap::new(),
    };
    let mut root_ids = Vec::new();
    for signing_key in offline {
        let public = signing_key.source().as_sign().await?.tuf_key();
        let id = public.key_id()?;
        root_ids.push(id.clone());
        root.keys.insert(id, public);
    }
    root.roles.insert(
        RoleType::Root,
        RoleKeys {
            keyids: root_ids,
            threshold: NonZeroU64::new(2).expect("two is nonzero"),
            _extra: HashMap::new(),
        },
    );
    for (role, signing_key) in [
        (RoleType::Targets, &top_level[0]),
        (RoleType::Snapshot, &top_level[1]),
        (RoleType::Timestamp, &top_level[2]),
    ] {
        let public = signing_key.source().as_sign().await?.tuf_key();
        let id = public.key_id()?;
        root.keys.insert(id.clone(), public);
        root.roles.insert(
            role,
            RoleKeys {
                keyids: vec![id],
                threshold: NonZeroU64::MIN,
                _extra: HashMap::new(),
            },
        );
    }
    let signed = SignedRole::new(
        root.clone(),
        &KeyHolder::Root(root),
        &[offline[0].source(), offline[1].source()],
        &SystemRandom::new(),
    )
    .await?;
    fs::write(destination, signed.buffer())?;
    Ok(())
}

fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

async fn run() -> Result<serde_json::Value, AnyError> {
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    let [fixture_root, payload_public_key] = arguments.as_slice() else {
        return Err(
            "usage: generate_test_updater_repository FIXTURE_ROOT PAYLOAD_PUBLIC_KEY".into(),
        );
    };
    let fixture_root = PathBuf::from(fixture_root);
    if !fixture_root.is_absolute() || fixture_root.exists() {
        return Err("fixture root must be a new absolute path".into());
    }
    let payload_public_key = PathBuf::from(payload_public_key);
    if !payload_public_key.is_absolute() || !payload_public_key.is_file() {
        return Err("payload public key must be an existing absolute file".into());
    }
    fs::create_dir_all(fixture_root.join("private"))?;
    let private = fixture_root.join("private");
    fs::write(
        fixture_root.join("TEST-ONLY"),
        b"Disposable updater qualification keys. Never use for publication.\n",
    )?;

    let offline = [
        TestKey::generate(&private, "root-1.der")?,
        TestKey::generate(&private, "root-2.der")?,
        TestKey::generate(&private, "root-3.der")?,
    ];
    let role_keys = [
        TestKey::generate(&private, "targets.der")?,
        TestKey::generate(&private, "snapshot.der")?,
        TestKey::generate(&private, "timestamp.der")?,
        TestKey::generate(&private, "releases.der")?,
        TestKey::generate(&private, "preview.der")?,
        TestKey::generate(&private, "stable.der")?,
    ];
    let trusted_root = fixture_root.join("trusted-root.json");
    write_root(&trusted_root, &offline, &role_keys[..3]).await?;

    let public_key = portcove_release_tools::decode_tauri_public_key(&payload_public_key)?;
    let public_key = public_key.as_bytes();
    fs::write(
        fixture_root.join("payload.json"),
        serde_json::to_vec_pretty(&json!({
            "schema_version": 1,
            "keys": [{
                "id": sha256(public_key),
                "tauri_public_key": STANDARD.encode(public_key)
            }]
        }))?,
    )?;

    let generated_at = Timestamp::now();
    let expires = |seconds| -> Result<String, AnyError> {
        Ok(generated_at
            .checked_add(Duration::from_secs(seconds))?
            .to_string())
    };
    let config = json!({
        "schema_version": 1,
        "generated_at": generated_at.to_string(),
        "trusted_root": "trusted-root.json",
        "reconstructed_records": "records",
        "payload_key_registry": "payload.json",
        "output": "repository",
        "keys": {
            "targets": "private/targets.der",
            "snapshot": "private/snapshot.der",
            "timestamp": "private/timestamp.der",
            "releases": "private/releases.der",
            "preview": "private/preview.der",
            "stable": "private/stable.der"
        },
        "versions": {
            "targets": 1,
            "snapshot": 1,
            "timestamp": 1,
            "releases": 1,
            "preview": 1,
            "stable": 1
        },
        "expires": {
            "targets": expires(60 * 86_400)?,
            "snapshot": expires(7 * 86_400)?,
            "timestamp": expires(48 * 3_600)?,
            "releases": expires(60 * 86_400)?,
            "preview": expires(7 * 86_400)?,
            "stable": expires(7 * 86_400)?
        }
    });
    let config_path = fixture_root.join("build-tuf.json");
    fs::write(&config_path, serde_json::to_vec_pretty(&config)?)?;
    Ok(json!({
        "fixture_root": fixture_root,
        "trusted_root": trusted_root,
        "build_config": config_path,
        "payload_public_key_sha256": sha256(public_key),
        "production_signing": false
    }))
}

#[tokio::main]
async fn main() {
    match run().await {
        Ok(result) => println!(
            "{}",
            serde_json::to_string(&result).expect("serialize result")
        ),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
