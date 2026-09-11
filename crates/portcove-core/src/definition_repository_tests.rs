use std::{
    collections::HashMap,
    fs,
    num::NonZeroU64,
    path::{Path, PathBuf},
};

use aws_lc_rs::{rand::SystemRandom, signature::Ed25519KeyPair};
use jiff::Timestamp;
use reqwest::Url;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use tough::{
    FilesystemTransport, TargetName,
    editor::{RepositoryEditor, signed::PathExists, signed::SignedRole},
    key_source::{KeySource, LocalKeySource},
    schema::{KeyHolder, PathPattern, PathSet, RoleKeys, RoleType, Root, Target},
};

use crate::{Catalog, ErrorCode, test_fixture::indexed_catalog_bundle};

use super::{
    DEFINITION_ROLE_PATHS, DefinitionHttpsTransport, DefinitionReplayDisposition,
    DefinitionRepositorySource, INDEX_TARGET, acquire_with_transport,
};

fn nz(value: u64) -> NonZeroU64 {
    NonZeroU64::new(value).unwrap()
}

fn later() -> Timestamp {
    Timestamp::now()
        .checked_add(std::time::Duration::from_secs(86_400))
        .unwrap()
}

fn earlier() -> Timestamp {
    Timestamp::new(0, 0).unwrap()
}

#[derive(Clone)]
struct Key(PathBuf);

impl Key {
    fn new(directory: &Path) -> Self {
        let document = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
        let file = tempfile::NamedTempFile::new_in(directory).unwrap();
        let (_, path) = file.keep().unwrap();
        fs::write(&path, document.as_ref()).unwrap();
        Self(path)
    }

    fn source(&self) -> Box<dyn KeySource> {
        Box::new(LocalKeySource {
            path: self.0.clone(),
        })
    }
}

struct RepositoryFixture {
    _directory: TempDir,
    offline: [Key; 3],
    online: Key,
    definitions: Key,
    root_path: PathBuf,
    source: PathBuf,
    metadata: PathBuf,
    targets: PathBuf,
}

impl RepositoryFixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let offline = [
            Key::new(directory.path()),
            Key::new(directory.path()),
            Key::new(directory.path()),
        ];
        let online = Key::new(directory.path());
        let definitions = Key::new(directory.path());
        let root_path = directory.path().join("trusted-root.json");
        let source = directory.path().join("source");
        let metadata = directory.path().join("metadata");
        let targets = directory.path().join("targets");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&metadata).unwrap();
        fs::create_dir(&targets).unwrap();
        Self {
            _directory: directory,
            offline,
            online,
            definitions,
            root_path,
            source,
            metadata,
            targets,
        }
    }

    async fn root(&self, consistent_snapshot: bool) -> Vec<u8> {
        let mut root = Root {
            spec_version: "1.0.0".into(),
            consistent_snapshot,
            version: nz(1),
            expires: later(),
            keys: HashMap::new(),
            roles: HashMap::new(),
            _extra: HashMap::new(),
        };
        let mut root_ids = Vec::new();
        for key in &self.offline {
            let public = key.source().as_sign().await.unwrap().tuf_key();
            let id = public.key_id().unwrap();
            root_ids.push(id.clone());
            root.keys.insert(id, public);
        }
        root.roles.insert(
            RoleType::Root,
            RoleKeys {
                keyids: root_ids,
                threshold: nz(2),
                _extra: HashMap::new(),
            },
        );
        let public = self.online.source().as_sign().await.unwrap().tuf_key();
        let id = public.key_id().unwrap();
        root.keys.insert(id.clone(), public);
        for role in [RoleType::Targets, RoleType::Snapshot, RoleType::Timestamp] {
            root.roles.insert(
                role,
                RoleKeys {
                    keyids: vec![id.clone()],
                    threshold: nz(1),
                    _extra: HashMap::new(),
                },
            );
        }
        let keys = self
            .offline
            .iter()
            .take(2)
            .map(Key::source)
            .collect::<Vec<_>>();
        let signed = SignedRole::new(
            root.clone(),
            &KeyHolder::Root(root),
            &keys,
            &SystemRandom::new(),
        )
        .await
        .unwrap();
        let bytes = signed.buffer().clone();
        fs::write(&self.root_path, &bytes).unwrap();
        bytes
    }

    async fn publish(
        &self,
        targets: &[(String, Vec<u8>)],
        consistent_snapshot: bool,
        role_paths: &[&str],
        expires: Timestamp,
    ) -> Vec<u8> {
        let root = self.root(consistent_snapshot).await;
        let mut inputs = Vec::new();
        for (name, bytes) in targets {
            let path = self.source.join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, bytes).unwrap();
            inputs.push((TargetName::new(name).unwrap(), path));
        }
        let paths = role_paths
            .iter()
            .map(|path| PathPattern::new(*path).unwrap())
            .collect();
        let mut editor = RepositoryEditor::new(&self.root_path).await.unwrap();
        editor
            .targets_version(nz(1))
            .unwrap()
            .targets_expires(expires)
            .unwrap()
            .snapshot_version(nz(1))
            .snapshot_expires(expires)
            .timestamp_version(nz(1))
            .timestamp_expires(expires)
            .delegate_role(
                "official-definitions",
                &[self.definitions.source()],
                PathSet::Paths(paths),
                true,
                nz(1),
                expires,
                nz(1),
            )
            .await
            .unwrap()
            .sign_targets_editor(&[self.online.source()])
            .await
            .unwrap()
            .change_delegated_targets("official-definitions")
            .unwrap();
        for (name, path) in &inputs {
            editor
                .add_target(name.clone(), Target::from_path(path).await.unwrap())
                .unwrap();
        }
        editor
            .targets_version(nz(1))
            .unwrap()
            .targets_expires(expires)
            .unwrap()
            .sign_targets_editor(&[self.definitions.source()])
            .await
            .unwrap()
            .change_delegated_targets("targets")
            .unwrap();
        editor
            .targets_version(nz(1))
            .unwrap()
            .targets_expires(expires)
            .unwrap();
        let signed = editor.sign(&[self.online.source()]).await.unwrap();
        signed.write(&self.metadata).await.unwrap();
        for (name, path) in &inputs {
            signed
                .copy_target(path, &self.targets, PathExists::Fail, Some(name))
                .await
                .unwrap();
        }
        root
    }

    fn metadata_url(&self) -> Url {
        Url::from_directory_path(&self.metadata).unwrap()
    }

    fn targets_url(&self) -> Url {
        Url::from_directory_path(&self.targets).unwrap()
    }

    fn published_target(&self, name: &str, bytes: &[u8], consistent: bool) -> PathBuf {
        if consistent {
            self.targets
                .join(format!("{}.{}", hex::encode(Sha256::digest(bytes)), name))
        } else {
            self.targets.join(name)
        }
    }
}

fn repository_targets() -> (String, Vec<(String, Vec<u8>)>) {
    let catalog = Catalog::embedded().unwrap();
    let port_id = catalog.ports()[0].id.clone();
    let bundle = indexed_catalog_bundle(&catalog, &port_id);
    let mut targets = vec![(INDEX_TARGET.to_owned(), bundle.index)];
    targets.extend(bundle.contents);
    (port_id, targets)
}

async fn acquire(
    fixture: &RepositoryFixture,
    root: &[u8],
) -> crate::Result<super::AuthenticatedDefinitionCandidate> {
    acquire_with_transport(
        root,
        fixture.metadata_url(),
        fixture.targets_url(),
        FilesystemTransport,
    )
    .await
}

#[test]
fn public_source_requires_credential_free_https_bases() {
    let source = DefinitionRepositorySource::new(
        "https://definitions.example/metadata",
        "https://definitions.example/targets/",
    )
    .unwrap();
    assert_eq!(
        source.metadata_base_url(),
        "https://definitions.example/metadata/"
    );
    assert!(
        DefinitionRepositorySource::new("http://example.test/", "https://example.test/").is_err()
    );
    assert!(
        DefinitionRepositorySource::new("https://user@example.test/", "https://example.test/")
            .is_err()
    );
    assert!(
        DefinitionRepositorySource::new(
            "https://example.test/?token=secret",
            "https://example.test/"
        )
        .is_err()
    );
    assert!(
        DefinitionRepositorySource::new(
            &format!("https://example.test/{}", "a".repeat(4096)),
            "https://example.test/"
        )
        .is_err()
    );
    let transport = DefinitionHttpsTransport::new(&source).unwrap();
    assert!(
        transport.accepts(&Url::parse("https://definitions.example/metadata/1.root.json").unwrap())
    );
    assert!(
        !transport.accepts(
            &Url::parse("https://definitions.example/metadata-escape/1.root.json").unwrap()
        )
    );
}

#[tokio::test]
async fn authenticated_candidate_projects_a_definition_published_after_the_client() {
    let fixture = RepositoryFixture::new();
    let (port_id, targets) = repository_targets();
    let root = fixture
        .publish(&targets, true, &DEFINITION_ROLE_PATHS, later())
        .await;

    let candidate = acquire(&fixture, &root).await.unwrap();
    let projection = candidate
        .inspect_catalog_projection("official", &port_id)
        .unwrap();
    assert_eq!(projection.entry().revision(), 7);
    assert_eq!(projection.catalog().port(&port_id).unwrap().id, port_id);
    assert_eq!(candidate.provenance().root_version, 1);
    assert_eq!(candidate.provenance().definitions_version, 1);
    assert_eq!(candidate.provenance().index_sha256.len(), 64);
    for digest in [
        &candidate.provenance().root_sha256,
        &candidate.provenance().timestamp_sha256,
        &candidate.provenance().snapshot_sha256,
        &candidate.provenance().targets_sha256,
        &candidate.provenance().definitions_sha256,
    ] {
        assert_eq!(digest.len(), 64);
        assert!(digest.bytes().all(|value| value.is_ascii_hexdigit()));
    }
}

#[tokio::test]
async fn replay_evaluation_rejects_downgrade_and_same_version_equivocation() {
    let fixture = RepositoryFixture::new();
    let (_, targets) = repository_targets();
    let root = fixture
        .publish(&targets, true, &DEFINITION_ROLE_PATHS, later())
        .await;
    let candidate = acquire(&fixture, &root).await.unwrap();

    assert_eq!(
        candidate.evaluate_replay(None).unwrap(),
        DefinitionReplayDisposition::Initial
    );
    let floor = candidate.replay_floor();
    assert_eq!(
        candidate.evaluate_replay(Some(&floor)).unwrap(),
        DefinitionReplayDisposition::ExactRetry
    );

    let mut newer_floor = floor.clone();
    newer_floor.snapshot_version += 1;
    newer_floor.snapshot_sha256 = "a".repeat(64);
    let downgrade = candidate.evaluate_replay(Some(&newer_floor)).unwrap_err();
    assert_eq!(downgrade.code, ErrorCode::Verification);
    assert_eq!(downgrade.details["role"], "snapshot");
    assert_eq!(downgrade.details["accepted_version"], "2");
    assert_eq!(downgrade.details["candidate_version"], "1");

    let mut replaced = floor;
    replaced.definitions_sha256 = "b".repeat(64);
    let equivocation = candidate.evaluate_replay(Some(&replaced)).unwrap_err();
    assert_eq!(equivocation.code, ErrorCode::Verification);
    assert_eq!(equivocation.details["role"], "official-definitions");
    assert_eq!(equivocation.details["version"], "1");

    let mut replaced_index = candidate.replay_floor();
    replaced_index.index_sha256 = "d".repeat(64);
    let index_equivocation = candidate
        .evaluate_replay(Some(&replaced_index))
        .unwrap_err();
    assert_eq!(index_equivocation.code, ErrorCode::Verification);
    assert_eq!(
        index_equivocation.message,
        "definition index changed without a delegated metadata version advance"
    );
}

#[tokio::test]
async fn replay_evaluation_allows_independent_monotonic_metadata_advance() {
    let fixture = RepositoryFixture::new();
    let (_, targets) = repository_targets();
    let root = fixture
        .publish(&targets, true, &DEFINITION_ROLE_PATHS, later())
        .await;
    let mut candidate = acquire(&fixture, &root).await.unwrap();
    let floor = candidate.replay_floor();

    candidate.provenance.timestamp_version += 1;
    candidate.provenance.timestamp_sha256 = "c".repeat(64);
    assert_eq!(
        candidate.evaluate_replay(Some(&floor)).unwrap(),
        DefinitionReplayDisposition::Advance
    );

    candidate.provenance.timestamp_sha256 = "not-a-digest".into();
    let corrupt = candidate.evaluate_replay(Some(&floor)).unwrap_err();
    assert_eq!(corrupt.code, ErrorCode::State);
    assert_eq!(corrupt.details["identity"], "timestamp");
}

#[tokio::test]
async fn unsupported_sibling_does_not_block_a_supported_definition() {
    let fixture = RepositoryFixture::new();
    let (port_id, mut targets) = repository_targets();
    let supported_entry = targets
        .iter()
        .find(|(name, _)| name.starts_with("sha256/"))
        .map(|(_, bytes)| bytes.clone())
        .unwrap();
    let index = targets
        .iter_mut()
        .find(|(name, _)| name == INDEX_TARGET)
        .unwrap();
    let mut incompatible: Value = serde_json::from_slice(&supported_entry).unwrap();
    incompatible["stable_id"] = "future-incompatible".into();
    incompatible["revision"] = 8.into();
    incompatible["port"]["id"] = "future-incompatible".into();
    incompatible["required_capabilities"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!({
            "template":"future-template","minimum_version":1,"maximum_version":1
        }));
    let incompatible = serde_json::to_vec_pretty(&incompatible).unwrap();
    let digest = hex::encode(Sha256::digest(&incompatible));
    let target = format!("sha256/{digest}.json");
    let mut index_value: Value = serde_json::from_slice(&index.1).unwrap();
    index_value["definitions"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!({
            "namespace":"official","stable_id":"future-incompatible","revision":8,"target":target
        }));
    index_value["contents"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!({
            "target":target,"sha256":digest,"length":incompatible.len()
        }));
    index.1 = serde_json::to_vec_pretty(&index_value).unwrap();
    targets.push((target, incompatible));
    let root = fixture
        .publish(&targets, true, &DEFINITION_ROLE_PATHS, later())
        .await;

    let candidate = acquire(&fixture, &root).await.unwrap();
    assert!(
        candidate
            .inspect_catalog_projection("official", &port_id)
            .is_ok()
    );
    let error = candidate
        .inspect_catalog_projection("official", "future-incompatible")
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Unsupported);
}

#[tokio::test]
async fn tampered_or_missing_content_is_refused() {
    for remove in [false, true] {
        let fixture = RepositoryFixture::new();
        let (_, targets) = repository_targets();
        let root = fixture
            .publish(&targets, true, &DEFINITION_ROLE_PATHS, later())
            .await;
        let (name, bytes) = targets
            .iter()
            .find(|(name, _)| name.starts_with("sha256/"))
            .unwrap();
        let path = fixture.published_target(name, bytes, true);
        if remove {
            fs::remove_file(path).unwrap();
        } else {
            fs::write(path, b"tampered").unwrap();
        }
        let error = acquire(&fixture, &root).await.unwrap_err();
        assert_eq!(
            error.code,
            if remove {
                ErrorCode::Network
            } else {
                ErrorCode::Verification
            },
            "{}",
            error.message
        );
    }
}

#[tokio::test]
async fn delegation_scope_and_consistent_snapshots_are_mandatory() {
    let (_, targets) = repository_targets();
    let fixture = RepositoryFixture::new();
    let root = fixture.publish(&targets, true, &["*"], later()).await;
    let scope_error = acquire(&fixture, &root).await.unwrap_err();
    assert_eq!(scope_error.code, ErrorCode::Verification);

    let fixture = RepositoryFixture::new();
    let root = fixture
        .publish(&targets, false, &DEFINITION_ROLE_PATHS, later())
        .await;
    let snapshot_error = acquire(&fixture, &root).await.unwrap_err();
    assert_eq!(snapshot_error.code, ErrorCode::Verification);
}

#[tokio::test]
async fn expired_metadata_is_refused_as_verification_failure() {
    let fixture = RepositoryFixture::new();
    let (_, targets) = repository_targets();
    let root = fixture
        .publish(&targets, true, &DEFINITION_ROLE_PATHS, earlier())
        .await;
    let error = acquire(&fixture, &root).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::Verification);
    assert!(error.message.contains("expired"));
}

#[tokio::test]
async fn authenticated_index_length_is_bounded_before_download() {
    let fixture = RepositoryFixture::new();
    let oversized = vec![b' '; super::MAX_INDEX_BYTES + 1];
    let targets = vec![(INDEX_TARGET.to_owned(), oversized)];
    let root = fixture
        .publish(&targets, true, &DEFINITION_ROLE_PATHS, later())
        .await;
    let error = acquire(&fixture, &root).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::Verification);
    assert!(error.message.contains("byte bound"), "{}", error.message);
}

#[tokio::test]
async fn index_and_tuf_target_metadata_must_agree_before_content_reads() {
    let fixture = RepositoryFixture::new();
    let (_, mut targets) = repository_targets();
    let index = targets
        .iter_mut()
        .find(|(name, _)| name == INDEX_TARGET)
        .unwrap();
    let mut value: Value = serde_json::from_slice(&index.1).unwrap();
    let length = value["contents"][0]["length"].as_u64().unwrap();
    value["contents"][0]["length"] = (length + 1).into();
    index.1 = serde_json::to_vec_pretty(&value).unwrap();
    let root = fixture
        .publish(&targets, true, &DEFINITION_ROLE_PATHS, later())
        .await;

    let error = acquire(&fixture, &root).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::Verification);
    assert!(
        error.message.contains("metadata disagree"),
        "{}",
        error.message
    );
}

#[tokio::test]
async fn caller_supplied_root_is_bounded_before_repository_access() {
    let fixture = RepositoryFixture::new();
    let oversized = vec![0; super::MAX_ROOT_BYTES + 1];
    let error = acquire(&fixture, &oversized).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::Verification);
    assert!(error.message.contains("root exceeds"), "{}", error.message);
}
