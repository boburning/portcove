//! Private generation evidence. This is not an installation or recovery grant.
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

use crate::{OperationCoordinator, PortcoveError, Result};
use serde::{Deserialize, Serialize};

// Keep the existing extraction ceilings; preparation cannot admit a larger tree.
const MAX_ENTRIES: usize = 100_000;
const MAX_BYTES: u64 = 16 * 1024 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const MAX_DEPTH: usize = 32;

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
enum Entry {
    Directory(crate::external_runtime::InspectedDirectory),
    File(crate::external_runtime::InspectedFile),
}

/// Only Core can create this value, after the generator has positively closed.
/// Serialized values must be loaded through the lifecycle owner, which binds
/// library custody and positive process closure before this inventory is used.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct GeneratedTree {
    root: PathBuf,
    operation_id: String,
    entries: BTreeMap<PathBuf, Entry>,
}

impl GeneratedTree {
    pub(super) fn operation_id(&self) -> &str {
        &self.operation_id
    }

    pub(super) fn root(&self) -> &Path {
        &self.root
    }
    pub(super) fn capture(
        root: &Path,
        operation: &OperationCoordinator,
        quiesced: bool,
    ) -> Result<Self> {
        if !quiesced {
            return Err(PortcoveError::state(
                "PS1 generation cannot yield without positive process closure",
            ));
        }
        crate::path::refuse_symlink_ancestors(root)?;
        let canonical = fs::canonicalize(root)?;
        let entries = inventory(&canonical, operation)?;
        operation.checkpoint()?;
        Ok(Self {
            root: canonical,
            operation_id: operation.operation_id().to_owned(),
            entries,
        })
    }

    pub(super) fn verify(&self, root: &Path, operation: &OperationCoordinator) -> Result<()> {
        operation.checkpoint()?;
        crate::path::refuse_symlink_ancestors(root)?;
        if operation.operation_id() != self.operation_id
            || fs::canonicalize(root)? != self.root
            || inventory(&self.root, operation)? != self.entries
        {
            return Err(PortcoveError::verification(
                "PS1 generated stage identity changed before continuation",
            ));
        }
        operation.checkpoint()
    }
}

fn inventory(root: &Path, operation: &OperationCoordinator) -> Result<BTreeMap<PathBuf, Entry>> {
    let mut entries = BTreeMap::new();
    let mut collision_keys = BTreeSet::new();
    let mut pending = vec![(root.to_path_buf(), 0_usize)];
    let root_identity = crate::external_runtime::inspect_directory(root)?;
    entries.insert(PathBuf::new(), Entry::Directory(root_identity.clone()));
    let mut total = 0_u64;
    while let Some((directory, depth)) = pending.pop() {
        operation.checkpoint()?;
        crate::path::refuse_symlink_ancestors(&directory)?;
        if depth > MAX_DEPTH || !fs::symlink_metadata(&directory)?.is_dir() {
            return Err(PortcoveError::verification("PS1 stage directory refused"));
        }
        for child in fs::read_dir(&directory)? {
            operation.checkpoint()?;
            if entries.len() >= MAX_ENTRIES {
                return Err(PortcoveError::verification(
                    "PS1 stage entry limit exceeded",
                ));
            }
            let path = child?.path();
            crate::path::refuse_symlink_ancestors(&path)?;
            let relative = path
                .strip_prefix(root)
                .map_err(|_| PortcoveError::verification("PS1 stage escaped its root"))?
                .to_path_buf();
            let (_, key) = crate::archive::validate_relative_path(
                &crate::path::unicode(&relative, "PS1 stage")?.replace('\\', "/"),
                false,
            )?;
            if !collision_keys.insert(key) {
                return Err(PortcoveError::verification(
                    "PS1 stage path collision refused",
                ));
            }
            let before = fs::symlink_metadata(&path)?;
            let entry = if before.is_dir() {
                pending.push((path.clone(), depth + 1));
                Entry::Directory(crate::external_runtime::inspect_directory(&path)?)
            } else if before.is_file() && before.len() <= MAX_FILE_BYTES {
                let maximum = before.len().min(MAX_BYTES.saturating_sub(total));
                if before.len() > maximum {
                    return Err(PortcoveError::verification("PS1 stage byte limit exceeded"));
                }
                let file = crate::external_runtime::hash_stable_file(&path, before.len(), &|| {
                    operation.checkpoint()
                })?;
                let size = before.len();
                crate::path::refuse_symlink_ancestors(&path)?;
                let after = fs::symlink_metadata(&path)?;
                if size != before.len()
                    || size > maximum
                    || !after.is_file()
                    || after.len() != before.len()
                    || after.modified()? != before.modified()?
                {
                    return Err(PortcoveError::verification(
                        "PS1 stage file changed during inventory",
                    ));
                }
                total = total
                    .checked_add(size)
                    .ok_or_else(|| PortcoveError::verification("PS1 stage size overflow"))?;
                Entry::File(file)
            } else {
                return Err(PortcoveError::verification(
                    "PS1 stage file type or size refused",
                ));
            };
            if entries.insert(relative, entry).is_some() {
                return Err(PortcoveError::verification(
                    "PS1 stage duplicate path refused",
                ));
            }
        }
    }
    // Fence the complete inventory after enumeration and hashing. No callback
    // can insert a path into an already enumerated directory without refusal.
    operation.checkpoint()?;
    if crate::external_runtime::inspect_directory(root)? != root_identity {
        return Err(PortcoveError::verification(
            "PS1 stage root changed during inventory",
        ));
    }
    verify_inventory(root, &entries)?;
    Ok(entries)
}

fn verify_inventory(root: &Path, entries: &BTreeMap<PathBuf, Entry>) -> Result<()> {
    let mut observed = BTreeSet::from([PathBuf::new()]);
    for (relative, entry) in entries {
        match entry {
            Entry::Directory(expected) => {
                let directory = root.join(relative);
                if crate::external_runtime::inspect_directory(&directory)? != *expected {
                    return Err(PortcoveError::verification(
                        "PS1 stage directory changed during inventory",
                    ));
                }
                // Repeat names as well as object metadata: timestamp precision
                // alone cannot prove that no child was inserted or removed.
                for child in fs::read_dir(&directory)? {
                    if observed.len() >= MAX_ENTRIES {
                        return Err(PortcoveError::verification(
                            "PS1 stage fence limit exceeded",
                        ));
                    }
                    let path = child?.path();
                    let relative = path
                        .strip_prefix(root)
                        .map_err(|_| {
                            PortcoveError::verification("PS1 stage fence escaped its root")
                        })?
                        .to_path_buf();
                    if !entries.contains_key(&relative) || !observed.insert(relative) {
                        return Err(PortcoveError::verification(
                            "PS1 stage path changed during inventory",
                        ));
                    }
                }
                if crate::external_runtime::inspect_directory(&directory)? != *expected {
                    return Err(PortcoveError::verification(
                        "PS1 stage directory changed during fence",
                    ));
                }
            }
            Entry::File(file) => crate::external_runtime::verify_inspected_file(file)?,
        }
    }
    if observed.len() != entries.len() {
        return Err(PortcoveError::verification(
            "PS1 stage inventory is incomplete",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_stage_refuses_uncertain_closure_and_changed_inputs() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("generated.c"), "original").unwrap();
        let operation = OperationCoordinator::new("stage-owner", None);
        assert!(GeneratedTree::capture(root.path(), &operation, false).is_err());
        let stage = GeneratedTree::capture(root.path(), &operation, true).unwrap();
        stage.verify(root.path(), &operation).unwrap();
        assert!(
            stage
                .verify(root.path(), &OperationCoordinator::new("other", None))
                .is_err()
        );
        fs::write(root.path().join("generated.c"), "changed!").unwrap();
        assert!(stage.verify(root.path(), &operation).is_err());
    }

    #[test]
    fn generated_stage_detects_added_and_removed_empty_directories() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("empty")).unwrap();
        let operation = OperationCoordinator::new("stage-owner", None);
        let stage = GeneratedTree::capture(root.path(), &operation, true).unwrap();
        fs::remove_dir(root.path().join("empty")).unwrap();
        assert!(stage.verify(root.path(), &operation).is_err());
        fs::create_dir(root.path().join("empty")).unwrap();
        // Recreating the same path does not restore custody of the old object.
        assert!(stage.verify(root.path(), &operation).is_err());
        let stage = GeneratedTree::capture(root.path(), &operation, true).unwrap();
        fs::create_dir(root.path().join("added")).unwrap();
        assert!(stage.verify(root.path(), &operation).is_err());
    }

    #[test]
    fn generated_stage_fence_rejects_paths_added_after_enumeration() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("generated.c"), "original").unwrap();
        let operation = OperationCoordinator::new("stage-owner", None);
        let canonical = fs::canonicalize(root.path()).unwrap();
        let mut entries = inventory(&canonical, &operation).unwrap();
        fs::write(root.path().join("inserted.c"), "not enumerated").unwrap();
        // Refresh only the directory metadata to exercise the name fence even
        // when metadata would otherwise look current (e.g. coarse timestamps).
        entries.insert(
            PathBuf::new(),
            Entry::Directory(crate::external_runtime::inspect_directory(&canonical).unwrap()),
        );
        assert!(verify_inventory(&canonical, &entries).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn generated_stage_refuses_case_collisions_and_leaf_symlinks() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("Game.c"), "one").unwrap();
        fs::write(root.path().join("game.c"), "two").unwrap();
        let operation = OperationCoordinator::new("stage-owner", None);
        assert!(GeneratedTree::capture(root.path(), &operation, true).is_err());
        fs::remove_file(root.path().join("game.c")).unwrap();
        std::os::unix::fs::symlink("Game.c", root.path().join("game.c")).unwrap();
        assert!(GeneratedTree::capture(root.path(), &operation, true).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn generated_stage_refuses_fifo_without_opening_it() {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        let root = tempfile::tempdir().unwrap();
        let fifo = root.path().join("generated.c");
        let name = CString::new(fifo.as_os_str().as_bytes()).unwrap();
        // SAFETY: the CString is live and terminated; the fixture owns this path.
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        let operation = OperationCoordinator::new("stage-owner", None);
        assert!(GeneratedTree::capture(root.path(), &operation, true).is_err());
    }
}
