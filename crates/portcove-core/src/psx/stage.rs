//! Private generation evidence. This is not an installation or recovery grant.
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    time::SystemTime,
};

use crate::{OperationCoordinator, PortcoveError, Result};
use serde::{Deserialize, Serialize};

// Keep the existing extraction ceilings; preparation cannot admit a larger tree.
const MAX_ENTRIES: usize = 100_000;
const MAX_BYTES: u64 = 16 * 1024 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const MAX_DEPTH: usize = 32;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
enum Entry {
    Directory(crate::external_runtime::InspectedDirectory),
    File(crate::external_runtime::InspectedFile),
}

/// Only Core can create this value, after the generator has positively closed.
/// Serialized values must be loaded through the lifecycle owner, which binds
/// library custody and positive process closure before this inventory is used.
#[derive(PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct GeneratedTree {
    root: PathBuf,
    operation_id: String,
    entries: BTreeMap<PathBuf, Entry>,
}

impl GeneratedTree {
    /// Only initial generation uses this transition, before durable sealing.
    /// Failure retains any partial normalization; it grants no retry authority.
    pub(super) fn capture_normalized_generation(
        root: &Path,
        operation: &OperationCoordinator,
        quiesced: bool,
    ) -> Result<Self> {
        let cutoff = SystemTime::now();
        let mut tree = Self::capture(root, operation, quiesced)?;
        for entry in tree.entries.values_mut() {
            if let Entry::File(file) = entry {
                *file = crate::external_runtime::normalize_generated_mtime(file, cutoff, &|| {
                    operation.checkpoint()
                })?;
            }
        }
        // Re-enumerate the full bounded tree, including names and directories;
        // no new/replaced object may be silently admitted by normalization.
        let current = Self::capture(root, operation, quiesced)?;
        if current != tree {
            return Err(PortcoveError::verification(
                "PS1 generation changed during timestamp normalization",
            ));
        }
        Ok(current)
    }

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

    /// Configuration may add its private build/cache tree, but cannot silently
    /// replace or rewrite any original generated input outside those subtrees.
    pub(super) fn configured_transition(
        &self,
        root: &Path,
        operation: &OperationCoordinator,
        quiesced: bool,
    ) -> Result<Self> {
        self.output_transition(root, operation, quiesced, &[], false)
    }

    pub(super) fn finalized_transition(
        &self,
        operation: &OperationCoordinator,
        removed: &[PathBuf],
    ) -> Result<Self> {
        self.output_transition(&self.root, operation, true, removed, true)
    }

    pub(super) fn manifest_transition(&self, operation: &OperationCoordinator) -> Result<Self> {
        let current = Self::capture(&self.root, operation, true)?;
        for (relative, original) in &self.entries {
            let unchanged = match (original, current.entries.get(relative)) {
                (Entry::Directory(before), Some(Entry::Directory(after))) => {
                    before.same_object(after)
                }
                (Entry::File(before), Some(Entry::File(after))) => before == after,
                _ => false,
            };
            if !unchanged {
                return Err(PortcoveError::verification(
                    "PS1 finalized payload changed during manifest creation",
                ));
            }
        }
        if current.entries.keys().any(|relative| {
            !self.entries.contains_key(relative) && relative != Path::new(".portcove-manifest.json")
        }) {
            return Err(PortcoveError::verification(
                "PS1 finalized payload gained an unexpected file",
            ));
        }
        current.verify(&self.root, operation)?;
        Ok(current)
    }

    fn output_transition(
        &self,
        root: &Path,
        operation: &OperationCoordinator,
        quiesced: bool,
        removed: &[PathBuf],
        finalized: bool,
    ) -> Result<Self> {
        let current = Self::capture(root, operation, quiesced)?;
        if current.root != self.root || current.operation_id != self.operation_id {
            return Err(PortcoveError::verification(
                "PS1 configure root custody changed",
            ));
        }
        if current
            .entries
            .keys()
            .any(|relative| removed.iter().any(|path| relative.starts_with(path)))
        {
            return Err(PortcoveError::verification(
                "PS1 removed input path reappeared in finalized payload",
            ));
        }
        let mutable = |relative: &Path| {
            relative.starts_with("build-portcove")
                || relative.starts_with(".portcove-builder-environment")
                || removed.iter().any(|path| relative.starts_with(path))
                || (finalized && relative == Path::new(".portcove-managed.json"))
        };
        for (relative, original) in &self.entries {
            if mutable(relative) {
                continue;
            }
            let unchanged = match (original, current.entries.get(relative)) {
                (Entry::Directory(before), Some(Entry::Directory(after))) => {
                    before.same_object(after)
                }
                (Entry::File(before), Some(Entry::File(after))) => before == after,
                _ => false,
            };
            if !unchanged {
                return Err(PortcoveError::verification(
                    "PS1 configure changed a retained generation input",
                ));
            }
        }
        for relative in current.entries.keys() {
            if !self.entries.contains_key(relative) && !mutable(relative) {
                return Err(PortcoveError::verification(
                    "PS1 configure added an unexpected input path",
                ));
            }
        }
        Ok(current)
    }

    /// Archive an input using its sealed inventory, never a fresh admission.
    pub(super) fn archive_input(
        &self,
        relative: &Path,
        destination: &Path,
        operation: &OperationCoordinator,
    ) -> Result<()> {
        let original = self
            .entries
            .get(relative)
            .ok_or_else(|| PortcoveError::verification("PS1 archived input was not sealed"))?;
        match original {
            Entry::Directory(_) => {
                let entries = self
                    .entries
                    .iter()
                    .filter_map(|(path, entry)| {
                        path.strip_prefix(relative)
                            .ok()
                            .map(|suffix| (suffix.to_path_buf(), entry.clone()))
                    })
                    .collect();
                Self {
                    root: self.root.join(relative),
                    operation_id: self.operation_id.clone(),
                    entries,
                }
                .archive(destination, operation)?;
            }
            Entry::File(before) => {
                let source = self.root.join(relative);
                let current =
                    crate::external_runtime::hash_stable_file(&source, before.size(), &|| {
                        operation.checkpoint()
                    })?;
                if before != &current {
                    return Err(PortcoveError::verification(
                        "PS1 archived file changed before retention",
                    ));
                }
                crate::path::refuse_symlink_ancestors(destination)?;
                crate::durability::rename_noreplace(&source, destination)?;
                let after =
                    crate::external_runtime::hash_stable_file(destination, before.size(), &|| {
                        operation.checkpoint()
                    })?;
                if !before.same_content_object(&after) {
                    return Err(PortcoveError::verification(
                        "PS1 retained file object changed",
                    ));
                }
            }
        }
        Ok(())
    }

    /// Rebind the complete retained inventory to original names and objects.
    pub(super) fn retained_inputs(
        &self,
        root: &Path,
        mappings: &[(PathBuf, PathBuf)],
        operation: &OperationCoordinator,
    ) -> Result<Self> {
        let current = Self::capture(root, operation, true)?;
        let mut expected = BTreeMap::new();
        for (source, destination) in mappings {
            for (relative, entry) in &self.entries {
                if let Ok(suffix) = relative.strip_prefix(source) {
                    if expected.insert(destination.join(suffix), entry).is_some() {
                        return Err(PortcoveError::verification(
                            "PS1 retained input mapping collision",
                        ));
                    }
                }
            }
        }
        if current.entries.len() != expected.len() + 1 {
            return Err(PortcoveError::verification(
                "PS1 retained input inventory changed",
            ));
        }
        for (relative, before) in expected {
            let unchanged = match (before, current.entries.get(&relative)) {
                (Entry::Directory(before), Some(Entry::Directory(after))) => {
                    before.same_object(after)
                }
                (Entry::File(before), Some(Entry::File(after))) => {
                    before.same_content_object(after)
                }
                _ => false,
            };
            if !unchanged {
                return Err(PortcoveError::verification(
                    "PS1 retained input differs from sealed compilation",
                ));
            }
        }
        current.verify(root, operation)?;
        Ok(current)
    }

    /// Move only this freshly verified private tree, retaining its exact objects.
    pub(super) fn archive(
        self,
        destination: &Path,
        operation: &OperationCoordinator,
    ) -> Result<Self> {
        self.verify(&self.root, operation)?;
        crate::path::refuse_symlink_ancestors(destination)?;
        crate::durability::rename_noreplace(&self.root, destination)?;
        let current = Self::capture(destination, operation, true)?;
        if current.operation_id != self.operation_id || current.entries.len() != self.entries.len()
        {
            return Err(PortcoveError::verification(
                "PS1 archived input inventory changed",
            ));
        }
        for (relative, before) in &self.entries {
            let unchanged = match (before, current.entries.get(relative)) {
                (Entry::Directory(before), Some(Entry::Directory(after))) => {
                    before.same_object(after)
                }
                (Entry::File(before), Some(Entry::File(after))) => {
                    before.same_content_object(after)
                }
                _ => false,
            };
            if !unchanged {
                return Err(PortcoveError::verification(
                    "PS1 archived input object changed",
                ));
            }
        }
        current.verify(destination, operation)?;
        Ok(current)
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
    fn generation_timestamp_normalization_requires_closure_and_preserves_inputs() {
        let root = tempfile::tempdir().unwrap();
        let future = root.path().join("generated.c");
        let past = root.path().join("original.txt");
        fs::write(&future, "generated source").unwrap();
        fs::write(&past, "original package").unwrap();
        let future_time = SystemTime::now() + std::time::Duration::from_secs(86_400);
        fs::File::options()
            .write(true)
            .open(&future)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(future_time))
            .unwrap();
        let past_time = fs::metadata(&past).unwrap().modified().unwrap();
        let operation = OperationCoordinator::new("normalize-owned-generation", None);
        assert!(
            GeneratedTree::capture_normalized_generation(root.path(), &operation, false).is_err()
        );
        assert_eq!(
            fs::metadata(&future).unwrap().modified().unwrap(),
            future_time
        );
        let before = SystemTime::now();
        let tree =
            GeneratedTree::capture_normalized_generation(root.path(), &operation, true).unwrap();
        let modified = fs::metadata(&future).unwrap().modified().unwrap();
        assert!(modified >= before && modified <= SystemTime::now());
        assert_eq!(fs::metadata(&past).unwrap().modified().unwrap(), past_time);
        assert_eq!(fs::read_to_string(&future).unwrap(), "generated source");
        tree.verify(root.path(), &operation).unwrap();
        assert!(!root.path().join(".portcove-managed.json").exists());
    }

    #[test]
    fn generation_timestamp_normalization_refuses_shared_objects_without_mutation() {
        let root = tempfile::tempdir().unwrap();
        let original = root.path().join("original.c");
        let alias = root.path().join("alias.c");
        fs::write(&original, "shared source").unwrap();
        fs::hard_link(&original, &alias).unwrap();
        let future = SystemTime::now() + std::time::Duration::from_secs(86_400);
        fs::File::options()
            .write(true)
            .open(&original)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(future))
            .unwrap();
        let operation = OperationCoordinator::new("normalize-owned-generation", None);
        assert!(
            GeneratedTree::capture_normalized_generation(root.path(), &operation, true).is_err()
        );
        assert_eq!(fs::metadata(&original).unwrap().modified().unwrap(), future);
        assert_eq!(fs::read_to_string(&alias).unwrap(), "shared source");
    }

    #[test]
    fn generation_timestamp_normalization_refuses_replacement_before_write() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("generated.c");
        let retained = root.path().join("retained.c");
        fs::write(&path, "original source").unwrap();
        let future = SystemTime::now() + std::time::Duration::from_secs(86_400);
        fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(future))
            .unwrap();
        let path = fs::canonicalize(&path).unwrap();
        let expected = crate::external_runtime::hash_stable_file(&path, 15, &|| Ok(())).unwrap();
        let calls = std::cell::Cell::new(0);
        let result = crate::external_runtime::normalize_generated_mtime(
            &expected,
            SystemTime::now(),
            &|| {
                calls.set(calls.get() + 1);
                if calls.get() == 2 {
                    fs::rename(&path, &retained)?;
                    fs::write(&path, "replacement source")?;
                }
                Ok(())
            },
        );
        assert!(result.is_err());
        assert_eq!(fs::metadata(&retained).unwrap().modified().unwrap(), future);
        assert_eq!(fs::read_to_string(&retained).unwrap(), "original source");
        assert_eq!(fs::read_to_string(&path).unwrap(), "replacement source");
    }

    #[test]
    fn configured_stage_preserves_original_inputs_and_bounds_new_paths() {
        let root = tempfile::tempdir().unwrap();
        let operation = OperationCoordinator::new("configure-transition", None);
        fs::write(root.path().join("game.c"), "original generated source").unwrap();
        let generated = GeneratedTree::capture(root.path(), &operation, true).unwrap();
        fs::create_dir(root.path().join("build-portcove")).unwrap();
        fs::write(
            root.path().join("build-portcove/build.ninja"),
            "inert graph",
        )
        .unwrap();
        assert!(
            generated
                .configured_transition(root.path(), &operation, false)
                .is_err()
        );
        fs::write(
            root.path().join("build-portcove/CMakeCache.txt"),
            "inert cache",
        )
        .unwrap();
        let configured = generated
            .configured_transition(root.path(), &operation, true)
            .unwrap();
        configured.verify(root.path(), &operation).unwrap();
        fs::write(root.path().join("unexpected.c"), "unexpected input").unwrap();
        assert!(
            generated
                .configured_transition(root.path(), &operation, true)
                .is_err()
        );
        fs::remove_file(root.path().join("unexpected.c")).unwrap();
        fs::write(root.path().join("game.c"), "changed generated source").unwrap();
        assert!(
            generated
                .configured_transition(root.path(), &operation, true)
                .is_err()
        );
        assert!(!root.path().join(".portcove-managed.json").exists());
    }

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
