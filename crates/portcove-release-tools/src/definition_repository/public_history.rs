//! Local retained catalog files. Keep immutable identities in memory and rebind
//! each body to the captured digest when authentication or assembly consumes it.
use super::*;

#[derive(Debug, Clone)]
enum PublicContent {
    Retained(PathBuf),
    Proposed(Arc<[u8]>),
}

#[derive(Debug, Clone)]
pub(super) struct PublicFile {
    identity: DefinitionFile,
    content: PublicContent,
}

#[derive(Debug, Clone, Default)]
pub(super) struct PublicHistory(BTreeMap<String, PublicFile>);

impl PublicFile {
    pub(super) fn read(&self) -> Result<Vec<u8>> {
        match &self.content {
            PublicContent::Proposed(bytes) => Ok(bytes.to_vec()),
            PublicContent::Retained(path) => {
                let bytes = io::read(path, self.identity.bytes)?;
                if !self.matches(&bytes) {
                    return invalid("catalog retained public file changed after inventory");
                }
                Ok(bytes)
            }
        }
    }

    pub(super) fn matches(&self, bytes: &[u8]) -> bool {
        self.identity.bytes == bytes.len() as u64 && self.identity.sha256 == sha(bytes)
    }

    pub(super) fn bytes(&self) -> u64 {
        self.identity.bytes
    }

    pub(super) fn digest(&self) -> &str {
        &self.identity.sha256
    }
}

impl PublicHistory {
    pub(super) fn read(root: &Path) -> Result<Self> {
        let entries = io::inventory(
            root,
            PUBLIC_REPOSITORY_MAX_FILES,
            PUBLIC_REPOSITORY_MAX_BYTES,
        )?;
        Ok(Self(
            entries
                .into_iter()
                .map(|identity| {
                    (
                        identity.target.clone(),
                        PublicFile {
                            content: PublicContent::Retained(root.join(&identity.target)),
                            identity,
                        },
                    )
                })
                .collect(),
        ))
    }

    pub(super) fn identities(&self) -> Vec<DefinitionFile> {
        self.0.values().map(|file| file.identity.clone()).collect()
    }

    pub(super) fn get(&self, name: &str) -> Option<&PublicFile> {
        self.0.get(name)
    }

    pub(super) fn file(&self, name: &str) -> Result<Vec<u8>> {
        self.get(name)
            .ok_or_else(|| {
                TufRepositoryError::Invalid(format!(
                    "catalog public repository file missing: {name}"
                ))
            })?
            .read()
    }

    pub(super) fn insert(&mut self, name: String, bytes: &[u8]) {
        self.0.insert(
            name.clone(),
            PublicFile {
                identity: DefinitionFile {
                    target: name,
                    bytes: bytes.len() as u64,
                    sha256: sha(bytes),
                },
                content: PublicContent::Proposed(Arc::from(bytes)),
            },
        );
    }

    pub(super) fn iter(&self) -> impl Iterator<Item = (&String, &PublicFile)> {
        self.0.iter()
    }

    pub(super) fn len(&self) -> usize {
        self.0.len()
    }

    pub(super) fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retained_bytes_are_rebound_before_use_and_overlays_keep_exact_inventory() {
        let input = tempfile::tempdir().unwrap();
        let file = input.path().join("retained.json");
        fs::write(&file, b"original").unwrap();
        let mut history = PublicHistory::read(input.path()).unwrap();
        let before = history.identities();
        assert_eq!(history.file("retained.json").unwrap(), b"original");
        history.insert("timestamp.json".into(), b"new timestamp");
        assert_eq!(history.identities()[0], before[0]);
        assert_eq!(history.file("timestamp.json").unwrap(), b"new timestamp");
        fs::write(&file, b"replaced").unwrap();
        assert!(history.file("retained.json").is_err());
        assert_ne!(
            PublicHistory::read(input.path()).unwrap().identities(),
            before
        );
    }
}
