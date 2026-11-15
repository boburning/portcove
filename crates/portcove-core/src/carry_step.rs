//! Tier 2 carry step (#5359, T2-2): the filesystem half of a carry.
//!
//! The planner (`carry_plan`) decides; this module inspects both versions'
//! files and applies a plan in two phases so the target never ends up with
//! only part of the source's files (design section 2, N1):
//!
//! 1. **Stage.** Each planned copy is written to a `.portcove-carry-*`
//!    temporary file beside its destination and hashed against the plan.
//!    Nothing at a destination path changes.
//! 2. **Verify.** Every source and destination is hashed again and compared
//!    with the plan (absent, or the bytes the plan approved replacing).
//! 3. **Publish.** Only then are the temporary files renamed into place and
//!    planned removals made. Just before each, the destination's size and
//!    modification time are compared with the verify pass.
//!
//! A failure before publishing deletes every temporary file and changes
//! nothing in the target. The service owns ledger rows, locking, progress and
//! the version switch itself.

// The service wiring lands in a later checkpoint and reads the stop details;
// until then only tests call this.
#![allow(dead_code)]

use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use crate::carry_plan::{CarryAction, PlannedPath, SourceCopy, TargetCopy};
use crate::{PortcoveError, Result};

/// Prefix of the temporary files a carry stages beside each destination.
pub(crate) const STAGING_PREFIX: &str = ".portcove-carry-";
/// Free space a carry keeps after staging: the larger of this and a fiftieth
/// of the volume (design section 7, as for backups).
pub(crate) const RESERVE_BYTES: u64 = 1024 * 1024 * 1024;
/// Allocation unit assumed when rounding each staged file up.
pub(crate) const CLUSTER_BYTES: u64 = 4096;

/// A file's digest and size.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Digest {
    pub(crate) sha256: String,
    pub(crate) size: u64,
}

/// Why staging or verifying stopped. Nothing in the target changed.
#[derive(Debug)]
pub(crate) enum CarryStop {
    /// The volume can't hold the staged files and the reserve; carry nothing.
    InsufficientSpace { required: u64, available: u64 },
    /// A source file changed after it was planned; the switch holds.
    SourceChanged(String),
    /// Another program holds a source or destination open; the switch holds
    /// and is retryable.
    Locked(String),
    /// Any other failure.
    Failed(PortcoveError),
}

impl From<PortcoveError> for CarryStop {
    fn from(error: PortcoveError) -> Self {
        Self::Failed(error)
    }
}

impl From<std::io::Error> for CarryStop {
    fn from(error: std::io::Error) -> Self {
        if is_sharing_violation(&error) {
            Self::Locked(String::new())
        } else {
            Self::Failed(error.into())
        }
    }
}

fn is_sharing_violation(error: &std::io::Error) -> bool {
    // ERROR_SHARING_VIOLATION and ERROR_LOCK_VIOLATION on Windows.
    cfg!(windows) && matches!(error.raw_os_error(), Some(32 | 33))
}

/// The path of a persistence-relative `/` path under `root`.
fn member(root: &Path, relative: &str) -> PathBuf {
    relative
        .split('/')
        .fold(root.to_path_buf(), |path, part| path.join(part))
}

/// Hash a regular file, refusing links and hard-linked files.
pub(crate) fn hash_file(path: &Path, checkpoint: &dyn Fn() -> Result<()>) -> Result<Digest> {
    let (sha256, size) = crate::external_runtime::hash_stable_regular(path, u64::MAX, checkpoint)?;
    Ok(Digest { sha256, size })
}

/// Whether every existing ancestor of `relative` under `root` is a directory
/// whose name matches exactly (case included) in its parent's listing, and
/// none is a link. A case variant or a non-directory makes the path blocked.
fn exact_parents(root: &Path, relative: &str) -> Result<Option<bool>> {
    let parts = relative.split('/').collect::<Vec<_>>();
    let mut directory = root.to_path_buf();
    for (index, part) in parts.iter().enumerate() {
        let listed = fs::read_dir(&directory)?
            .map(|entry| entry.map(|entry| entry.file_name()))
            .collect::<std::io::Result<Vec<_>>>()?;
        let exact = listed.iter().any(|name| name.as_os_str() == *part);
        let folded = listed.iter().any(|name| {
            name.to_str()
                .is_some_and(|name| name.eq_ignore_ascii_case(part) && name != *part)
        });
        if folded && !exact {
            return Ok(Some(false));
        }
        let next = directory.join(part);
        let last = index + 1 == parts.len();
        if !exact {
            // Missing from here down: absent, with parents to create.
            return Ok(None);
        }
        let metadata = fs::symlink_metadata(&next)?;
        if metadata.file_type().is_symlink() || (!last && !metadata.is_dir()) {
            return Ok(Some(false));
        }
        directory = next;
    }
    Ok(Some(true))
}

/// What the target holds at a path, for the planner.
pub(crate) fn inspect_target(
    root: &Path,
    relative: &str,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<TargetCopy> {
    match exact_parents(root, relative)? {
        Some(false) => Ok(TargetCopy::Blocked),
        None => Ok(TargetCopy::Absent),
        Some(true) => {
            let path = member(root, relative);
            if !fs::symlink_metadata(&path)?.is_file() {
                return Ok(TargetCopy::Blocked);
            }
            match hash_file(&path, checkpoint) {
                Ok(digest) => Ok(TargetCopy::File {
                    sha256: digest.sha256,
                }),
                Err(_) => Ok(TargetCopy::Unreadable),
            }
        }
    }
}

/// What the source holds at a path, for the planner, with its size.
pub(crate) fn inspect_source(
    root: &Path,
    relative: &str,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<(SourceCopy, Option<u64>)> {
    match exact_parents(root, relative)? {
        None => Ok((SourceCopy::Absent, None)),
        Some(false) => Ok((SourceCopy::Unreadable, None)),
        Some(true) => match hash_file(&member(root, relative), checkpoint) {
            Ok(digest) => Ok((
                SourceCopy::File {
                    sha256: digest.sha256,
                },
                Some(digest.size),
            )),
            Err(_) => Ok((SourceCopy::Unreadable, None)),
        },
    }
}

/// Delete leftover temporary files from an interrupted carry, anywhere under
/// the target's persistence root. Only regular files with the staging prefix
/// are removed.
pub(crate) fn sweep(root: &Path) -> Result<usize> {
    let mut removed = 0;
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries {
            let entry = entry?;
            let metadata = fs::symlink_metadata(entry.path())?;
            if metadata.is_dir() {
                pending.push(entry.path());
            } else if metadata.is_file()
                && entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| name.starts_with(STAGING_PREFIX))
            {
                fs::remove_file(entry.path())?;
                removed += 1;
            }
        }
    }
    Ok(removed)
}

/// Bytes a carry must have free before staging: every copied file rounded up
/// to the cluster size, plus the reserve.
pub(crate) fn required_bytes(
    plan: &[PlannedPath],
    sizes: &BTreeMap<String, u64>,
    total: u64,
) -> u64 {
    plan.iter()
        .filter(|planned| matches!(planned.action, CarryAction::Copy | CarryAction::Replace))
        .map(|planned| sizes.get(&planned.path).copied().unwrap_or(0))
        .map(|size| size.div_ceil(CLUSTER_BYTES).saturating_mul(CLUSTER_BYTES))
        .fold(RESERVE_BYTES.max(total / 50), u64::saturating_add)
}

/// One staged copy, waiting to be published.
#[derive(Debug)]
struct StagedCopy {
    path: String,
    temporary: PathBuf,
    destination: PathBuf,
    /// The bytes the plan approved replacing, or `None` when absent.
    replaces: Option<String>,
    /// The destination as the verify pass saw it.
    seen: Option<(u64, SystemTime)>,
}

/// A staged and verified carry. Dropping it without publishing deletes every
/// temporary file.
#[derive(Debug)]
pub(crate) struct Staged {
    copies: Vec<StagedCopy>,
    removals: Vec<(String, PathBuf, String, (u64, SystemTime))>,
    /// Paths whose target changed since planning: the switch writes nothing
    /// there and records them as kept separately.
    pub(crate) changed_targets: Vec<String>,
    published: bool,
}

impl Drop for Staged {
    fn drop(&mut self) {
        if !self.published {
            for copy in &self.copies {
                let _ = fs::remove_file(&copy.temporary);
            }
        }
    }
}

fn snapshot(path: &Path) -> Result<Option<(u64, SystemTime)>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() => Ok(Some((metadata.len(), metadata.modified()?))),
        Ok(_) => Err(PortcoveError::conflict(
            "a carried file's destination is not a regular file",
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

/// What inspection found for the planned paths.
#[derive(Debug, Default)]
pub(crate) struct Inspected {
    /// Source file sizes, for the space check.
    pub(crate) sizes: BTreeMap<String, u64>,
    pub(crate) source_digests: BTreeMap<String, String>,
    pub(crate) target_digests: BTreeMap<String, String>,
}

/// Stage and verify every copy, replacement and removal in `plan`.
/// `available` and `total` describe the target's volume.
pub(crate) fn stage(
    (source_root, target_root): (&Path, &Path),
    plan: &[PlannedPath],
    inspected: &Inspected,
    (available, total): (u64, u64),
    checkpoint: &dyn Fn() -> Result<()>,
) -> std::result::Result<Staged, CarryStop> {
    let Inspected {
        sizes,
        source_digests,
        target_digests,
    } = inspected;
    let required = required_bytes(plan, sizes, total);
    let copying = plan
        .iter()
        .any(|planned| matches!(planned.action, CarryAction::Copy | CarryAction::Replace));
    if copying && required > available {
        return Err(CarryStop::InsufficientSpace {
            required,
            available,
        });
    }
    let mut staged = Staged {
        copies: Vec::new(),
        removals: Vec::new(),
        changed_targets: Vec::new(),
        published: false,
    };
    for planned in plan {
        checkpoint()?;
        let replaces = match planned.action {
            CarryAction::Copy => None,
            CarryAction::Replace | CarryAction::Remove => {
                Some(target_digests.get(&planned.path).cloned().ok_or_else(|| {
                    PortcoveError::state("a planned replacement has no target digest")
                })?)
            }
            _ => continue,
        };
        let destination = member(target_root, &planned.path);
        if planned.action == CarryAction::Remove {
            continue_removal(&mut staged, planned, destination, replaces);
            continue;
        }
        let expected = source_digests
            .get(&planned.path)
            .ok_or_else(|| PortcoveError::state("a planned copy has no source digest"))?;
        let parent = destination
            .parent()
            .ok_or_else(|| PortcoveError::state("a carried file has no parent"))?;
        fs::create_dir_all(parent)?;
        crate::path::refuse_symlink_ancestors(&destination)?;
        let mut output = tempfile::Builder::new()
            .prefix(STAGING_PREFIX)
            .tempfile_in(parent)?;
        let source = member(source_root, &planned.path);
        let copied =
            copy_hashing(&source, output.as_file_mut(), checkpoint).map_err(|stop| match stop {
                CarryStop::Locked(_) => CarryStop::Locked(planned.path.clone()),
                other => other,
            })?;
        if copied != *expected {
            return Err(CarryStop::SourceChanged(planned.path.clone()));
        }
        output.as_file().sync_all()?;
        let (_, temporary) = output
            .keep()
            .map_err(|error| PortcoveError::from(error.error))?;
        staged.copies.push(StagedCopy {
            path: planned.path.clone(),
            temporary,
            destination,
            replaces,
            seen: None,
        });
    }
    verify(&mut staged, source_root, source_digests, checkpoint)?;
    Ok(staged)
}

fn continue_removal(
    staged: &mut Staged,
    planned: &PlannedPath,
    destination: PathBuf,
    replaces: Option<String>,
) {
    // The snapshot is taken in the verify pass.
    staged.removals.push((
        planned.path.clone(),
        destination,
        replaces.unwrap_or_default(),
        (0, SystemTime::UNIX_EPOCH),
    ));
}

fn copy_hashing(
    source: &Path,
    output: &mut fs::File,
    checkpoint: &dyn Fn() -> Result<()>,
) -> std::result::Result<String, CarryStop> {
    use sha2::{Digest as _, Sha256};
    crate::runtime_data_policy::refuse_sensitive_entry(source)?;
    let mut input = crate::external_runtime::open_single_link_file(source)?;
    let before = input.metadata()?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    let mut total = 0_u64;
    loop {
        checkpoint()?;
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        total += count as u64;
        hasher.update(&buffer[..count]);
        output.write_all(&buffer[..count])?;
    }
    if total != before.len() || input.metadata()?.modified()? != before.modified()? {
        return Err(CarryStop::SourceChanged(String::new()));
    }
    crate::runtime_data_policy::preserve_modified_time(output, &before)?;
    Ok(hex::encode(hasher.finalize()))
}

/// Re-hash every source and destination against the plan (M4). A target that
/// changed moves to `changed_targets` and is left alone.
fn verify(
    staged: &mut Staged,
    source_root: &Path,
    source_digests: &BTreeMap<String, String>,
    checkpoint: &dyn Fn() -> Result<()>,
) -> std::result::Result<(), CarryStop> {
    let mut changed = Vec::new();
    for copy in &mut staged.copies {
        let source = hash_file(&member(source_root, &copy.path), checkpoint)
            .map_err(|_| CarryStop::SourceChanged(copy.path.clone()))?;
        if Some(&source.sha256) != source_digests.get(&copy.path) {
            return Err(CarryStop::SourceChanged(copy.path.clone()));
        }
        let seen = snapshot(&copy.destination)?;
        let current = match seen {
            None => None,
            Some(_) => Some(hash_file(&copy.destination, checkpoint)?.sha256),
        };
        if current != copy.replaces {
            changed.push(copy.path.clone());
            let _ = fs::remove_file(&copy.temporary);
            continue;
        }
        copy.seen = seen;
    }
    staged.copies.retain(|copy| !changed.contains(&copy.path));
    let mut removals = Vec::new();
    for (path, destination, expected, _) in staged.removals.drain(..) {
        let seen = snapshot(&destination)?;
        let current = match seen {
            None => None,
            Some(_) => Some(hash_file(&destination, checkpoint)?.sha256),
        };
        match (seen, current) {
            (Some(seen), Some(current)) if current == expected => {
                removals.push((path, destination, expected, seen));
            }
            // Already gone: nothing to remove.
            (None, _) => {}
            _ => changed.push(path),
        }
    }
    staged.removals = removals;
    staged.changed_targets = changed;
    Ok(())
}

impl Staged {
    /// The paths that will be written or removed.
    pub(crate) fn written(&self) -> Vec<&str> {
        self.copies
            .iter()
            .map(|copy| copy.path.as_str())
            .chain(self.removals.iter().map(|(path, ..)| path.as_str()))
            .collect()
    }

    /// Rename every staged copy into place and make the planned removals.
    /// Not cancellable. A destination that changed since the verify pass is
    /// left alone and returned, to be recorded as kept separately.
    pub(crate) fn publish(mut self) -> std::result::Result<Vec<String>, CarryStop> {
        self.published = true;
        let mut kept = Vec::new();
        let mut copies = std::mem::take(&mut self.copies).into_iter();
        while let Some(copy) = copies.next() {
            if snapshot(&copy.destination)? != copy.seen {
                kept.push(copy.path.clone());
                let _ = fs::remove_file(&copy.temporary);
                continue;
            }
            let publication = crate::durability::tempfile_destination(&copy.destination)?;
            if let Err(error) = fs::rename(&copy.temporary, &publication) {
                // This and the remaining copies stay staged for recovery to
                // finish or sweep.
                let path = copy.path.clone();
                self.copies = std::iter::once(copy).chain(copies).collect();
                self.published = false;
                return Err(if is_sharing_violation(&error) {
                    CarryStop::Locked(path)
                } else {
                    CarryStop::Failed(error.into())
                });
            }
            if let Some(parent) = copy.destination.parent() {
                let _ = crate::durability::sync_publication(parent);
            }
        }
        for (path, destination, _, seen) in std::mem::take(&mut self.removals) {
            if snapshot(&destination)? != Some(seen) {
                kept.push(path);
                continue;
            }
            if let Err(error) = fs::remove_file(&destination) {
                return Err(if is_sharing_violation(&error) {
                    CarryStop::Locked(path)
                } else {
                    CarryStop::Failed(error.into())
                });
            }
        }
        Ok(kept)
    }
}

#[cfg(test)]
#[path = "carry_step/tests.rs"]
mod tests;
