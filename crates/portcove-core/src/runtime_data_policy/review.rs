//! Read-only review of the exact data the retained mirror may collect.
use super::*;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

#[derive(Debug, PartialEq, Eq, Serialize)]
pub(crate) enum ReviewedEntry {
    Missing,
    Directory,
    File {
        size: u64,
        sha256: String,
        modified: String,
    },
}

pub(crate) type ReviewedTree = BTreeMap<PathBuf, ReviewedEntry>;

#[derive(Default)]
pub(crate) struct DataReview {
    entries: usize,
    bytes: u64,
}

impl DataReview {
    pub(crate) fn entry(
        &mut self,
        port: &PortDefinition,
        root: &Path,
        canonical: &Path,
    ) -> Result<ReviewedTree> {
        validate(port)?;
        let omit_credentials = port.runtime_data_policy.is_some();
        if omit_credentials {
            // Same closed omission policy as mirror: validate names/types, never
            // open credential bytes or serialize their content/identity.
            refuse_sensitive_tree(canonical)?;
            validate_runtime_names(root)?;
        } else {
            refuse_sensitive_tree(root)?;
        }
        self.tree(root, omit_credentials)
    }

    pub(crate) fn canonical(&mut self, root: &Path) -> Result<ReviewedTree> {
        refuse_sensitive_tree(root)?;
        self.tree(root, false)
    }

    fn tree(&mut self, root: &Path, omit_credentials: bool) -> Result<ReviewedTree> {
        let mut result = BTreeMap::new();
        let mut pending = vec![PathBuf::new()];
        let mut names = BTreeSet::new();
        while let Some(relative) = pending.pop() {
            self.entries += 1;
            if self.entries > 65_536 || relative.components().count() > 64 {
                return Err(PortcoveError::unsupported(
                    "player-data review limit reached",
                ));
            }
            let path = if relative.as_os_str().is_empty() {
                root.to_path_buf()
            } else {
                root.join(&relative)
            };
            crate::path::refuse_symlink_ancestors(&path)?;
            let before = match fs::symlink_metadata(&path) {
                Err(error)
                    if error.kind() == std::io::ErrorKind::NotFound
                        && relative.as_os_str().is_empty() =>
                {
                    result.insert(relative, ReviewedEntry::Missing);
                    continue;
                }
                result => result?,
            };
            if !names
                .insert(crate::path::unicode(&relative, "reviewed player data")?.to_lowercase())
            {
                return Err(PortcoveError::conflict(
                    "player data has case-colliding paths",
                ));
            }
            if before.is_dir() && !before.file_type().is_symlink() {
                for entry in fs::read_dir(&path)? {
                    let entry = entry?;
                    let kind = entry.file_type()?;
                    crate::archive::validate_relative_path(
                        &crate::path::unicode(
                            Path::new(&entry.file_name()),
                            "player data filename",
                        )?,
                        kind.is_dir(),
                    )?;
                    if omit_credentials && sensitive_name(&entry.file_name()) {
                        if !kind.is_file() {
                            return Err(held(&entry.path()));
                        }
                        continue;
                    }
                    pending.push(relative.join(entry.file_name()));
                    if pending.len() + self.entries > 65_536 {
                        return Err(PortcoveError::unsupported(
                            "player-data review entry limit reached",
                        ));
                    }
                }
                if fs::symlink_metadata(&path)?.modified()? != before.modified()? {
                    return Err(changed(&path));
                }
                result.insert(relative, ReviewedEntry::Directory);
            } else if before.is_file() && !before.file_type().is_symlink() {
                self.bytes = self
                    .bytes
                    .checked_add(before.len())
                    .ok_or_else(|| changed(&path))?;
                if before.len() > 64 * 1024_u64.pow(3) || self.bytes > 256 * 1024_u64.pow(3) {
                    return Err(PortcoveError::unsupported(
                        "player-data review byte limit reached",
                    ));
                }
                let mut input = crate::external_runtime::open_single_link_file(&path)?;
                let opened = input.metadata()?;
                let mut digest = Sha256::new();
                let mut size = 0;
                let mut buffer = [0; 64 * 1024];
                loop {
                    let count = input.read(&mut buffer)?;
                    if count == 0 {
                        break;
                    }
                    size += count as u64;
                    if size > opened.len() {
                        return Err(changed(&path));
                    }
                    digest.update(&buffer[..count]);
                }
                let after = input.metadata()?;
                crate::path::refuse_symlink_ancestors(&path)?;
                let current = fs::symlink_metadata(&path)?;
                if size != opened.len()
                    || opened.len() != before.len()
                    || after.len() != opened.len()
                    || opened.modified()? != before.modified()?
                    || after.modified()? != opened.modified()?
                    || current.len() != opened.len()
                    || current.modified()? != opened.modified()?
                    || same_file::Handle::from_file(input.try_clone()?)?
                        != same_file::Handle::from_path(&path)?
                {
                    return Err(changed(&path));
                }
                result.insert(
                    relative,
                    ReviewedEntry::File {
                        size,
                        sha256: hex::encode(digest.finalize()),
                        modified: modified_stamp(&opened)?,
                    },
                );
            } else {
                return Err(PortcoveError::conflict(
                    "player-data review found a link or special entry",
                )
                .detail("path", path.display().to_string()));
            }
        }
        Ok(result)
    }
}

fn changed(path: &Path) -> PortcoveError {
    PortcoveError::conflict("player data changed during read-only review; review the action again")
        .detail("path", path.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn review_binds_modification_time_when_player_bytes_are_unchanged() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("asset.bin");
        fs::write(&path, b"owned original").unwrap();
        let stamp = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        let file = fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.set_times(fs::FileTimes::new().set_modified(stamp))
            .unwrap();
        let before = DataReview::default().canonical(root.path()).unwrap();
        file.set_times(
            fs::FileTimes::new().set_modified(stamp + std::time::Duration::from_secs(1)),
        )
        .unwrap();
        let after = DataReview::default().canonical(root.path()).unwrap();
        assert_ne!(before, after);
        assert_eq!(fs::read(path).unwrap(), b"owned original");
    }

    #[test]
    fn review_distinguishes_missing_directory_and_file_without_creating_data() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("settings");
        let missing = DataReview::default().canonical(&path).unwrap();
        assert_eq!(missing[Path::new("")], ReviewedEntry::Missing);
        assert!(!path.exists());
        fs::create_dir(&path).unwrap();
        let directory = DataReview::default().canonical(&path).unwrap();
        assert_eq!(directory[Path::new("")], ReviewedEntry::Directory);
        fs::remove_dir(&path).unwrap();
        fs::write(&path, b"player settings").unwrap();
        let file = DataReview::default().canonical(&path).unwrap();
        assert!(matches!(
            file[Path::new("")],
            ReviewedEntry::File { size: 15, .. }
        ));
        assert_ne!(directory, file);
        let alias = root.path().join("alias");
        fs::hard_link(&path, &alias).unwrap();
        assert!(DataReview::default().canonical(&path).is_err());
        assert_eq!(fs::read(alias).unwrap(), b"player settings");
    }

    #[test]
    fn closed_policy_review_omits_credential_content_but_refuses_canonical_contamination() {
        let root = tempfile::tempdir().unwrap();
        let runtime = root.path().join("runtime");
        let canonical = root.path().join("canonical");
        fs::create_dir(&runtime).unwrap();
        fs::write(runtime.join("save.dat"), b"progress").unwrap();
        fs::write(runtime.join(CREDENTIAL), b"secret one").unwrap();
        let port = crate::Catalog::embedded()
            .unwrap()
            .port("wave-race-64-racewave46")
            .unwrap()
            .clone();
        let first = DataReview::default()
            .entry(&port, &runtime, &canonical)
            .unwrap();
        fs::write(
            runtime.join(CREDENTIAL),
            b"different secret which is never hashed",
        )
        .unwrap();
        assert_eq!(
            first,
            DataReview::default()
                .entry(&port, &runtime, &canonical)
                .unwrap()
        );
        assert!(
            !first
                .keys()
                .any(|path| path.file_name().is_some_and(sensitive_name))
        );
        assert!(!canonical.exists());
        fs::create_dir(&canonical).unwrap();
        fs::write(canonical.join(CREDENTIAL), b"must not be exported").unwrap();
        assert!(
            DataReview::default()
                .entry(&port, &runtime, &canonical)
                .is_err()
        );
        fs::remove_file(runtime.join(CREDENTIAL)).unwrap();
        fs::create_dir(runtime.join(CREDENTIAL)).unwrap();
        fs::remove_file(canonical.join(CREDENTIAL)).unwrap();
        assert!(
            DataReview::default()
                .entry(&port, &runtime, &canonical)
                .is_err()
        );
    }
}
