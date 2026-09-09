use std::collections::HashMap;
use std::fs;
use std::num::NonZeroU64;
use std::path::{Path, PathBuf};

use aws_lc_rs::{rand::SystemRandom, signature::Ed25519KeyPair};
use jiff::Timestamp;
use tempfile::TempDir;
use tough::editor::{RepositoryEditor, signed::SignedRole};
use tough::key_source::{KeySource, LocalKeySource};
use tough::schema::{KeyHolder, RoleKeys, RoleType, Root};
use tough::{Repository, RepositoryLoader};
use url::Url;

pub fn nz(value: u64) -> NonZeroU64 {
    NonZeroU64::new(value).unwrap()
}

pub fn expiration() -> Timestamp {
    Timestamp::now()
        .checked_add(std::time::Duration::from_secs(86_400))
        .unwrap()
}

#[derive(Clone)]
pub struct Key(PathBuf);

impl Key {
    pub async fn new(directory: &Path) -> Self {
        let document = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
        let file = tempfile::NamedTempFile::new_in(directory).unwrap();
        let (_, path) = file.keep().unwrap();
        fs::write(&path, document.as_ref()).unwrap();
        Self(path)
    }

    pub fn source(&self) -> Box<dyn KeySource> {
        Box::new(LocalKeySource {
            path: self.0.clone(),
        })
    }
}

pub struct Fixture {
    pub offline: [Key; 3],
    pub online: Key,
    pub directory: TempDir,
    pub metadata: PathBuf,
    pub targets: PathBuf,
}

impl Fixture {
    pub async fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let offline = [
            Key::new(directory.path()).await,
            Key::new(directory.path()).await,
            Key::new(directory.path()).await,
        ];
        let online = Key::new(directory.path()).await;
        let metadata = directory.path().join("metadata");
        let targets = directory.path().join("targets");
        fs::create_dir(&metadata).unwrap();
        fs::create_dir(&targets).unwrap();
        Self {
            offline,
            online,
            directory,
            metadata,
            targets,
        }
    }

    pub async fn root(&self, version: u64, offline: &[Key], online: &Key) -> Root {
        let mut root = Root {
            spec_version: "1.0.0".into(),
            consistent_snapshot: false,
            version: nz(version),
            expires: expiration(),
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
                threshold: nz(2),
                _extra: HashMap::new(),
            },
        );
        let public = online.source().as_sign().await.unwrap().tuf_key();
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
        root
    }

    pub async fn sign_root(&self, root: &Root, holder: &Root, keys: &[Key]) -> Vec<u8> {
        SignedRole::new(
            root.clone(),
            &KeyHolder::Root(holder.clone()),
            &keys.iter().map(Key::source).collect::<Vec<_>>(),
            &SystemRandom::new(),
        )
        .await
        .unwrap()
        .buffer()
        .clone()
    }

    pub async fn publish(&self, root: &[u8], online: &Key, version: u64, expires: Timestamp) {
        let root_path = self.directory.path().join("editor-root.json");
        fs::write(&root_path, root).unwrap();
        let target = self.targets.join("release.json");
        fs::write(&target, br#"{"schema":1,"version":"0.1.0","fixture":true}"#).unwrap();
        let mut editor = RepositoryEditor::new(root_path).await.unwrap();
        editor
            .targets_version(nz(version))
            .unwrap()
            .targets_expires(expires)
            .unwrap()
            .snapshot_version(nz(version))
            .snapshot_expires(expires)
            .timestamp_version(nz(version))
            .timestamp_expires(expires);
        editor.add_target_path(target).await.unwrap();
        editor
            .sign(&[online.source()])
            .await
            .unwrap()
            .write(&self.metadata)
            .await
            .unwrap();
    }

    pub fn metadata_url(&self) -> Url {
        Url::from_directory_path(&self.metadata).unwrap()
    }

    pub fn targets_url(&self) -> Url {
        Url::from_directory_path(&self.targets).unwrap()
    }

    pub async fn load(&self, trusted: &[u8]) -> Result<Repository, tough::error::Error> {
        RepositoryLoader::new(&trusted, self.metadata_url(), self.targets_url())
            .load()
            .await
    }
}
