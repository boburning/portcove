use std::collections::HashMap;
use std::fs;
use std::num::NonZeroU64;
use std::path::{Path, PathBuf};
use std::time::Duration;

use aws_lc_rs::{rand::SystemRandom, signature::Ed25519KeyPair};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use futures_util::TryStreamExt;
use jiff::Timestamp;
use portcove_release_tools::tuf_repository::build_tuf_repository;
use serde_json::json;
use sha2::{Digest, Sha256};
use tough::editor::signed::SignedRole;
use tough::key_source::{KeySource, LocalKeySource};
use tough::schema::{KeyHolder, RoleKeys, RoleType, Root};
use tough::{RepositoryLoader, TargetName};
use url::Url;

fn key(path: PathBuf) -> Box<dyn KeySource> {
    Box::new(LocalKeySource { path })
}

fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

#[derive(Clone)]
struct TestKey(PathBuf);

impl TestKey {
    fn generate(directory: &Path, name: &str) -> Self {
        let bytes = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
        let path = directory.join(name);
        fs::write(&path, bytes.as_ref()).unwrap();
        Self(path)
    }

    fn source(&self) -> Box<dyn KeySource> {
        key(self.0.clone())
    }
}

async fn write_root(directory: &Path, offline: &[TestKey], top: &[TestKey]) -> PathBuf {
    let mut root = Root {
        spec_version: "1.0.0".into(),
        consistent_snapshot: true,
        version: NonZeroU64::MIN,
        expires: Timestamp::now()
            .checked_add(Duration::from_secs(300 * 86_400))
            .unwrap(),
        keys: HashMap::new(),
        roles: HashMap::new(),
        _extra: HashMap::new(),
    };
    let mut root_ids = Vec::new();
    for key in offline {
        let public = key.source().as_sign().await.unwrap().tuf_key();
        let id = public.key_id().unwrap();
        root_ids.push(id.clone());
        root.keys.insert(id, public);
    }
    root.roles.insert(
        RoleType::Root,
        RoleKeys {
            keyids: root_ids,
            threshold: NonZeroU64::new(2).unwrap(),
            _extra: HashMap::new(),
        },
    );
    for (role, key) in [
        (RoleType::Targets, &top[0]),
        (RoleType::Snapshot, &top[1]),
        (RoleType::Timestamp, &top[2]),
    ] {
        let public = key.source().as_sign().await.unwrap().tuf_key();
        let id = public.key_id().unwrap();
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
    .await
    .unwrap();
    let path = directory.join("trusted-root.json");
    fs::write(&path, signed.buffer()).unwrap();
    path
}

fn write_records(directory: &Path) -> Vec<String> {
    let records = [
        ("release", None, "releases/1.0.0/windows-x86_64/nsis.json"),
        (
            "promotion",
            Some("preview"),
            "channels/preview/windows-x86_64/nsis/1.0.0.json",
        ),
        (
            "promotion",
            Some("stable"),
            "channels/stable/windows-x86_64/nsis/1.0.0.json",
        ),
    ];
    let mut identities = Vec::new();
    let mut paths = Vec::new();
    for (kind, channel, path) in records {
        let bytes = format!("{{\"path\":\"{path}\"}}\n").into_bytes();
        let destination = directory.join(Path::new(path));
        fs::create_dir_all(destination.parent().unwrap()).unwrap();
        fs::write(&destination, &bytes).unwrap();
        identities.push(json!({
            "kind": kind,
            "channel": channel,
            "path": path,
            "version": "1.0.0",
            "target": "windows-x86_64",
            "package": "nsis",
            "bytes": bytes.len(),
            "sha256": sha256(&bytes),
        }));
        paths.push(path.to_owned());
    }
    fs::write(
        directory.join("reconstruction-manifest.json"),
        serde_json::to_vec(&json!({ "schema_version": 1, "records": identities })).unwrap(),
    )
    .unwrap();
    paths
}

#[tokio::test]
async fn builds_separately_signed_repository_and_accepts_exact_retry() {
    let directory = tempfile::tempdir().unwrap();
    let offline = [
        TestKey::generate(directory.path(), "root-1.der"),
        TestKey::generate(directory.path(), "root-2.der"),
        TestKey::generate(directory.path(), "root-3.der"),
    ];
    let role_keys: Vec<_> = [
        "targets.der",
        "snapshot.der",
        "timestamp.der",
        "releases.der",
        "preview.der",
        "stable.der",
    ]
    .into_iter()
    .map(|name| TestKey::generate(directory.path(), name))
    .collect();
    let root = write_root(directory.path(), &offline, &role_keys[..3]).await;
    let records_root = directory.path().join("records");
    fs::create_dir(&records_root).unwrap();
    let target_paths = write_records(&records_root);
    let payload_public_key = b"untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\n";
    fs::write(
        directory.path().join("payload.json"),
        serde_json::to_vec(&json!({
            "schema_version": 1,
            "keys": [{
                "id": sha256(payload_public_key),
                "tauri_public_key": STANDARD.encode(payload_public_key)
            }]
        }))
        .unwrap(),
    )
    .unwrap();
    let generated_at = Timestamp::now();
    let expires = |seconds| {
        generated_at
            .checked_add(Duration::from_secs(seconds))
            .unwrap()
            .to_string()
    };
    let config = json!({
        "schema_version": 1,
        "generated_at": generated_at.to_string(),
        "trusted_root": root.file_name().unwrap().to_str().unwrap(),
        "reconstructed_records": "records",
        "payload_key_registry": "payload.json",
        "output": "repository",
        "keys": {
            "targets": "targets.der",
            "snapshot": "snapshot.der",
            "timestamp": "timestamp.der",
            "releases": "releases.der",
            "preview": "preview.der",
            "stable": "stable.der"
        },
        "versions": {
            "targets": 1, "snapshot": 1, "timestamp": 1,
            "releases": 1, "preview": 1, "stable": 1
        },
        "expires": {
            "targets": expires(60 * 86_400),
            "snapshot": expires(7 * 86_400),
            "timestamp": expires(48 * 3_600),
            "releases": expires(60 * 86_400),
            "preview": expires(7 * 86_400),
            "stable": expires(7 * 86_400)
        }
    });
    let config_path = directory.path().join("config.json");
    fs::write(&config_path, serde_json::to_vec(&config).unwrap()).unwrap();

    let first = build_tuf_repository(&config_path).await.unwrap();
    assert!(first.changed);
    assert_eq!(first.records, 3);
    assert!(first.output.join("repository-manifest.json").is_file());
    let second = build_tuf_repository(&config_path).await.unwrap();
    assert!(!second.changed);
    assert_eq!(first.files, second.files);

    let mut duplicate_key_config = config.clone();
    duplicate_key_config["output"] = json!("repository-duplicate-key");
    duplicate_key_config["keys"]["stable"] = json!("preview.der");
    let duplicate_key_path = directory.path().join("duplicate-key.json");
    fs::write(
        &duplicate_key_path,
        serde_json::to_vec(&duplicate_key_config).unwrap(),
    )
    .unwrap();
    let error = build_tuf_repository(&duplicate_key_path).await.unwrap_err();
    assert!(error.to_string().contains("must use distinct keys"));

    let stable_key_path = directory.path().join("stable.der");
    let original_stable_key = fs::read(&stable_key_path).unwrap();
    let replacement_stable_key = TestKey::generate(directory.path(), "replacement-stable.der");
    fs::copy(&replacement_stable_key.0, &stable_key_path).unwrap();
    let error = build_tuf_repository(&config_path).await.unwrap_err();
    assert!(
        error
            .to_string()
            .contains("delegated key inventory differs")
    );
    fs::write(&stable_key_path, original_stable_key).unwrap();

    let trusted = fs::read(root).unwrap();
    let repository = RepositoryLoader::new(
        &trusted,
        Url::from_directory_path(first.output.join("metadata")).unwrap(),
        Url::from_directory_path(first.output.join("targets")).unwrap(),
    )
    .load()
    .await
    .unwrap();
    for path in target_paths {
        let target = repository
            .read_target(&TargetName::new(path).unwrap())
            .await
            .unwrap()
            .unwrap()
            .try_collect::<Vec<_>>()
            .await
            .unwrap();
        assert!(!target.concat().is_empty());
    }
    fs::write(first.output.join("repository-manifest.json"), b"{}").unwrap();
    let error = build_tuf_repository(&config_path).await.unwrap_err();
    assert!(error.to_string().contains("malformed"));
}

#[tokio::test]
async fn rejects_a_record_changed_after_reconstruction() {
    let directory = tempfile::tempdir().unwrap();
    let records_root = directory.path().join("records");
    fs::create_dir(&records_root).unwrap();
    let paths = write_records(&records_root);
    fs::write(records_root.join(Path::new(&paths[0])), b"tampered").unwrap();
    fs::write(directory.path().join("root"), b"root").unwrap();
    fs::write(directory.path().join("payload"), b"{}").unwrap();
    for name in [
        "targets",
        "snapshot",
        "timestamp",
        "releases",
        "preview",
        "stable",
    ] {
        fs::write(directory.path().join(name), b"key").unwrap();
    }
    let config = json!({
        "schema_version": 1,
        "generated_at": "2034-01-01T00:00:00Z",
        "trusted_root": "root",
        "reconstructed_records": "records",
        "payload_key_registry": "payload",
        "output": "repository",
        "keys": {
            "targets": "targets", "snapshot": "snapshot", "timestamp": "timestamp",
            "releases": "releases", "preview": "preview", "stable": "stable"
        },
        "versions": {
            "targets": 1, "snapshot": 1, "timestamp": 1,
            "releases": 1, "preview": 1, "stable": 1
        },
        "expires": {
            "targets": "2034-03-01T00:00:00Z", "snapshot": "2034-01-08T00:00:00Z",
            "timestamp": "2034-01-02T00:00:00Z", "releases": "2034-03-01T00:00:00Z",
            "preview": "2034-01-08T00:00:00Z", "stable": "2034-01-08T00:00:00Z"
        }
    });
    let config_path = directory.path().join("config.json");
    fs::write(&config_path, serde_json::to_vec(&config).unwrap()).unwrap();
    let error = build_tuf_repository(&config_path).await.unwrap_err();
    assert!(error.to_string().contains("record identity changed"));
    assert!(!directory.path().join("repository").exists());
}
