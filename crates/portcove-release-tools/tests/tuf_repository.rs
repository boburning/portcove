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

const PAYLOAD_PUBLIC_KEY: &[u8] = b"untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\n";

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
    write_version_records(directory, "1.0.0")
}

fn write_version_records(directory: &Path, version: &str) -> Vec<String> {
    write_platform_records(directory, version, &[("windows-x86_64", "nsis")])
}

fn write_platform_records(
    directory: &Path,
    version: &str,
    platforms: &[(&str, &str)],
) -> Vec<String> {
    let mut identities = Vec::new();
    let mut paths = Vec::new();
    for &(target, package) in platforms {
        let records = [
            (
                "release",
                None,
                format!("releases/{version}/{target}/{package}.json"),
            ),
            (
                "promotion",
                Some("preview"),
                format!("channels/preview/{target}/{package}/{version}.json"),
            ),
            (
                "promotion",
                Some("stable"),
                format!("channels/stable/{target}/{package}/{version}.json"),
            ),
        ];
        for (kind, channel, path) in records {
            let release_path = format!("releases/{version}/{target}/{package}.json");
            let release = json!({
                "schema_version": 1, "version": version,
                "source_commit": "a".repeat(40), "source_tree": "b".repeat(40),
                "qualified_run": {"workflow":"release.yml", "workflow_commit":"e".repeat(40), "run_id":42, "attempt":1, "inventory_sha256":"f".repeat(64)},
                "target": target, "os": if target.starts_with("windows") {"windows"} else {"linux"},
                "architecture":"x86_64", "execution_context":if package == "nsis" {"native"} else {"user-owned-appimage"},
                "package":{"kind":package,"owner":"portcove","product_id":"portcove-desktop"},
                "artifact":{"url":format!("https://github.com/boburning/portcove/releases/download/v{version}/fixture-{package}"),"sha256":"c".repeat(64),"bytes":1024,"tauri_signature":"fixture-signature","payload_key_id":sha256(PAYLOAD_PUBLIC_KEY)},
                "compatibility":{"minimum_os_version":if package == "nsis" {"10.0.19045"} else {"5.15.0"},"required_capabilities":["host-api-1"],"cli_protocol":{"min":1,"max":1},"catalog_formats":[2],"library":{"read":{"min":1,"max":1},"write_schema":1,"lock_protocol":"library-lock-v1"}},
                "evidence_ids":["synthetic-disposable-producer-fixture"]
            });
            let release_bytes = serde_json::to_vec(&release).unwrap();
            let bytes = if kind == "release" {
                release_bytes
            } else {
                serde_json::to_vec(&json!({
            "schema_version":1, "channel":channel, "target":target,"package":package,"version":version,
            "release_path":release_path,"release_sha256":sha256(&release_bytes),
            "eligible":true,"production_eligible":true,"withdrawn":false,"reason":null,"required_bridge":null
        })).unwrap()
            };
            let destination = directory.join(Path::new(&path));
            fs::create_dir_all(destination.parent().unwrap()).unwrap();
            fs::write(&destination, &bytes).unwrap();
            identities.push(json!({
                "kind": kind,
                "channel": channel,
                "path": path,
                "version": version,
                "target": target,
                "package": package,
                "bytes": bytes.len(),
                "sha256": sha256(&bytes),
            }));
            paths.push(path.to_owned());
        }
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
    let payload_public_key = PAYLOAD_PUBLIC_KEY;
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

    // Provision the broad but bounded namespaces while the disposable offline
    // key exists, then physically remove it before any routine role operation.
    let mut bootstrap = config.clone();
    bootstrap["schema_version"] = json!(2);
    bootstrap["output"] = json!("bootstrap");
    let bootstrap_config = directory.path().join("bootstrap.json");
    fs::write(&bootstrap_config, serde_json::to_vec(&bootstrap).unwrap()).unwrap();
    build_tuf_repository(&bootstrap_config).await.unwrap();
    let offline_targets = directory.path().join("bootstrap/metadata/1.targets.json");
    let offline_bytes = fs::read(&offline_targets).unwrap();
    let targets_private = fs::read(&role_keys[0].0).unwrap();
    fs::remove_file(&role_keys[0].0).unwrap();
    assert!(!role_keys[0].0.exists());
    let mut online = bootstrap.clone();
    online["keys"].as_object_mut().unwrap().remove("targets");
    online["offline_targets"] = json!("bootstrap/metadata/1.targets.json");
    let online_config = directory.path().join("online.json");
    for (generation, version) in [(1, "1.0.0"), (2, "1.1.0"), (3, "1.2.0")] {
        let records_name = format!("online-records-{generation}");
        let records = directory.path().join(&records_name);
        fs::create_dir(&records).unwrap();
        let paths = write_platform_records(
            &records,
            version,
            &[("windows-x86_64", "nsis"), ("linux-x86_64", "appimage")],
        );
        online["reconstructed_records"] = json!(records_name);
        online["output"] = json!(format!("online-{generation}"));
        for role in ["snapshot", "timestamp", "releases", "preview", "stable"] {
            online["versions"][role] = json!(generation);
        }
        fs::write(&online_config, serde_json::to_vec(&online).unwrap()).unwrap();
        assert!(!role_keys[0].0.exists());
        let built = build_tuf_repository(&online_config).await.unwrap();
        assert_eq!(
            fs::read(built.output.join("metadata/1.targets.json")).unwrap(),
            offline_bytes
        );
        assert!(!build_tuf_repository(&online_config).await.unwrap().changed);
        let reader = RepositoryLoader::new(
            &fs::read(&root).unwrap(),
            Url::from_directory_path(built.output.join("metadata")).unwrap(),
            Url::from_directory_path(built.output.join("targets")).unwrap(),
        )
        .load()
        .await
        .unwrap();
        for path in paths {
            let actual = reader
                .read_target(&TargetName::new(&path).unwrap())
                .await
                .unwrap()
                .unwrap()
                .try_collect::<Vec<_>>()
                .await
                .unwrap()
                .concat();
            assert_eq!(actual, fs::read(records.join(path)).unwrap());
        }
    }
    let online_output = directory.path().join("online-3");
    let before_refusals = build_tuf_repository(&online_config).await.unwrap().files;
    let mut damaged: serde_json::Value = serde_json::from_slice(&offline_bytes).unwrap();
    damaged["signatures"][0]["sig"] = json!("00".repeat(64));
    fs::write(&offline_targets, serde_json::to_vec(&damaged).unwrap()).unwrap();
    assert!(
        build_tuf_repository(&online_config).await.is_err(),
        "retry must authenticate offline input"
    );
    fs::write(&offline_targets, &offline_bytes).unwrap();
    assert_eq!(
        build_tuf_repository(&online_config).await.unwrap().files,
        before_refusals
    );
    assert!(online_output.is_dir());

    let registry_path = directory.path().join("payload.json");
    let original_registry = fs::read(&registry_path).unwrap();
    let mut changed_registry = original_registry.clone();
    changed_registry.push(b'\n'); // Valid JSON, differing immutable bytes.
    fs::write(&registry_path, changed_registry).unwrap();
    assert!(
        build_tuf_repository(&online_config)
            .await
            .unwrap_err()
            .to_string()
            .contains("registry bytes differ")
    );
    fs::write(&registry_path, original_registry).unwrap();

    let mut changed_key = online.clone();
    changed_key["keys"]["stable"] = json!("unadmitted-stable.der");
    TestKey::generate(directory.path(), "unadmitted-stable.der");
    let refusal_config = directory.path().join("online-refusal.json");
    let mut ambiguous = online.clone();
    ambiguous["keys"]["targets"] = json!("targets.der");
    fs::write(&refusal_config, serde_json::to_vec(&ambiguous).unwrap()).unwrap();
    assert!(
        build_tuf_repository(&refusal_config)
            .await
            .unwrap_err()
            .to_string()
            .contains("schema is unsupported")
    );
    assert!(!role_keys[0].0.exists());
    fs::write(&refusal_config, serde_json::to_vec(&changed_key).unwrap()).unwrap();
    assert!(
        build_tuf_repository(&refusal_config)
            .await
            .unwrap_err()
            .to_string()
            .contains("key or role inventory differs")
    );

    let out_of_scope = directory.path().join("out-of-scope-records");
    fs::create_dir(&out_of_scope).unwrap();
    write_version_records(&out_of_scope, "1.3.0");
    let manifest_path = out_of_scope.join("reconstruction-manifest.json");
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    let old_path = manifest["records"][0]["path"].as_str().unwrap().to_owned();
    let outside_path = old_path.replace("windows-x86_64/nsis", "macos-aarch64/dmg");
    let destination = out_of_scope.join(&outside_path);
    fs::create_dir_all(destination.parent().unwrap()).unwrap();
    fs::rename(out_of_scope.join(old_path), destination).unwrap();
    manifest["records"][0]["path"] = json!(outside_path);
    manifest["records"][0]["target"] = json!("macos-aarch64");
    manifest["records"][0]["package"] = json!("dmg");
    fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    let mut outside = online.clone();
    outside["reconstructed_records"] = json!("out-of-scope-records");
    outside["output"] = json!("outside-refused");
    fs::write(&refusal_config, serde_json::to_vec(&outside).unwrap()).unwrap();
    assert!(
        build_tuf_repository(&refusal_config)
            .await
            .unwrap_err()
            .to_string()
            .contains("outside the offline bootstrap namespaces")
    );
    assert!(!directory.path().join("outside-refused").exists());
    assert!(!role_keys[0].0.exists());
    assert_eq!(
        build_tuf_repository(&online_config).await.unwrap().files,
        before_refusals
    );
    // Restore only for the independent legacy-schema refusal tests below.
    fs::write(&role_keys[0].0, targets_private).unwrap();

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
    if let Some(output) = std::env::var_os("PORTCOVE_TUF_ONLINE_QUALIFICATION_OUTPUT") {
        let output = PathBuf::from(output);
        assert!(output.is_absolute());
        fs::create_dir(&output).expect("qualification export must be fresh");
        fs::write(output.join("trusted-root.json"), &trusted).unwrap();
        for generation in 1..=3 {
            copy_public_fixture(
                &directory.path().join(format!("online-{generation}")),
                &output.join(format!("online-{generation}")),
            );
        }
        let private_store = directory.path().to_path_buf();
        directory.close().unwrap();
        assert!(!private_store.exists());
        fs::write(
            output.join("producer-teardown.json"),
            serde_json::to_vec(
                &json!({"private_store":private_store,"removed":true,"qualification_only":true}),
            )
            .unwrap(),
        )
        .unwrap();
    }
}

fn copy_public_fixture(source: &Path, destination: &Path) {
    fs::create_dir(destination).unwrap();
    for entry in fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        let kind = entry.file_type().unwrap();
        assert!(!kind.is_symlink());
        if kind.is_dir() {
            copy_public_fixture(&entry.path(), &destination.join(entry.file_name()));
        } else {
            assert!(kind.is_file());
            assert!(entry.file_name().to_str().unwrap().ends_with(".json"));
            fs::copy(entry.path(), destination.join(entry.file_name())).unwrap();
        }
    }
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
