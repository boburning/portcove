//! Tier 2 carry step (#5359, T2-2): the filesystem half of a carry.
//!
//! The planner (`carry_plan`) decides; this module inspects both versions'
//! files and applies a plan in two phases so the target never ends up with
//! only part of the source's files (design section 2, N1):
//!
//! 1. **Stage.** Each planned copy is written to a `.portcove-carry-*`
//!    temporary file in its nearest existing destination ancestor and hashed
//!    against the bytes the plan approved. Nothing at a destination path changes.
//! 2. **Verify.** Every source and destination is hashed again and compared
//!    with the plan (absent, or the bytes the plan approved replacing).
//! 3. **Publish.** Only then are the temporary files renamed into place and
//!    planned removals made. Just before each, the destination's parents are
//!    checked again for links and case variants and its size and
//!    modification time are compared with the verify pass.
//!
//! A failure before publishing deletes every temporary file and changes
//! nothing in the target. A failure part-way through publishing leaves the
//! copies already renamed and deletes the rest; the caller must have
//! committed the pending rows first, so a retry re-plans those copies as
//! Portcove's own placement, and must not activate the target. The service
//! owns ledger rows, locking, progress and the version switch itself.

// The service wiring lands in a later checkpoint and reads the stop details;
// until then only tests call this.
#![allow(dead_code)]

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::ffi::OsString;
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

/// Why staging, verifying or publishing stopped.
#[derive(Debug)]
pub(crate) enum CarryStop {
    /// The volume can't hold the staged files and the reserve; carry nothing
    /// and let the switch go ahead.
    InsufficientSpace {
        required: u64,
        available: Option<u64>,
    },
    /// Destination storage filled while writing a private staging file.
    StagingStorageFull,
    /// A source file changed after it was planned; the switch holds.
    SourceChanged(String),
    /// Another program holds the file open; the switch holds and is
    /// retryable.
    Locked(String),
    /// Any other failure; the switch holds.
    Failed(PortcoveError),
}

impl From<PortcoveError> for CarryStop {
    fn from(error: PortcoveError) -> Self {
        Self::Failed(error)
    }
}

impl From<std::io::Error> for CarryStop {
    fn from(error: std::io::Error) -> Self {
        Self::Failed(error.into())
    }
}

/// Whether an OS error means another program holds the file.
fn is_sharing_violation(error: &std::io::Error) -> bool {
    // ERROR_SHARING_VIOLATION and ERROR_LOCK_VIOLATION on Windows.
    cfg!(windows) && matches!(error.raw_os_error(), Some(32 | 33))
}

/// Whether a rename or removal failed because another program holds the
/// destination: on Windows, often ERROR_ACCESS_DENIED from antivirus.
fn is_held(error: &std::io::Error) -> bool {
    is_sharing_violation(error) || (cfg!(windows) && error.raw_os_error() == Some(5))
}

/// Probe whether `path` is held open by another program.
fn locked(path: &Path) -> bool {
    matches!(fs::File::open(path), Err(error) if is_sharing_violation(&error))
}

/// The hold a locked file causes.
pub(crate) fn locked_error(relative: &str) -> PortcoveError {
    PortcoveError::conflict(
        "Another program is using a file Portcove would carry to the new version. Nothing was changed. Close the game and any program using the file, then try again.",
    )
    .detail("carried_file_unreadable", relative)
}

/// The path of a persistence-relative `/` path under `root`.
fn member(root: &Path, relative: &str) -> PathBuf {
    relative
        .split('/')
        .fold(root.to_path_buf(), |path, part| path.join(part))
}

/// Folder listings read once per carry (review finding 6).
#[derive(Debug, Default)]
pub(crate) struct Listings(RefCell<BTreeMap<PathBuf, Vec<OsString>>>);

impl Listings {
    fn names(&self, directory: &Path) -> Result<Vec<OsString>> {
        if let Some(names) = self.0.borrow().get(directory) {
            return Ok(names.clone());
        }
        let names = fs::read_dir(directory)?
            .map(|entry| entry.map(|entry| entry.file_name()))
            .collect::<std::io::Result<Vec<_>>>()?;
        self.0
            .borrow_mut()
            .insert(directory.to_path_buf(), names.clone());
        Ok(names)
    }
}

/// Hash a regular file, refusing links and hard-linked files.
pub(crate) fn hash_file(path: &Path, checkpoint: &dyn Fn() -> Result<()>) -> Result<Digest> {
    let (sha256, size) = crate::external_runtime::hash_stable_regular(path, u64::MAX, checkpoint)?;
    Ok(Digest { sha256, size })
}

/// Whether every existing ancestor of `relative` under `root` is a directory
/// whose name matches exactly (case included) in its parent's listing, and
/// none is a link: `Some(true)` when the whole path exists that way, `None`
/// when it is missing from some point down, and `Some(false)` for a case
/// variant, a link or a non-directory parent.
fn exact_parents(root: &Path, relative: &str, listings: &Listings) -> Result<Option<bool>> {
    let parts = relative.split('/').collect::<Vec<_>>();
    let mut directory = root.to_path_buf();
    for (index, part) in parts.iter().enumerate() {
        let listed = listings.names(&directory)?;
        let exact = listed.iter().any(|name| name.as_os_str() == *part);
        let folded = listed.iter().any(|name| {
            name.to_str()
                .is_some_and(|name| name != *part && name.eq_ignore_ascii_case(part))
        });
        if folded && !exact {
            return Ok(Some(false));
        }
        if !exact {
            return Ok(None);
        }
        let next = directory.join(part);
        let metadata = fs::symlink_metadata(&next)?;
        let last = index + 1 == parts.len();
        if metadata.file_type().is_symlink() || (!last && !metadata.is_dir()) {
            return Ok(Some(false));
        }
        directory = next;
    }
    Ok(Some(true))
}

/// What the target holds at a path, for the planner. A file another program
/// holds open is an error: the switch holds.
pub(crate) fn inspect_target(
    root: &Path,
    relative: &str,
    listings: &Listings,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<TargetCopy> {
    let path = member(root, relative);
    if crate::runtime_data_policy::refuse_sensitive_entry(&path).is_err() {
        return Ok(TargetCopy::Blocked);
    }
    match exact_parents(root, relative, listings)? {
        Some(false) => Ok(TargetCopy::Blocked),
        None => Ok(TargetCopy::Absent),
        Some(true) => {
            if !fs::symlink_metadata(&path)?.is_file() {
                return Ok(TargetCopy::Blocked);
            }
            match hash_file(&path, checkpoint) {
                Ok(digest) => Ok(TargetCopy::File {
                    sha256: digest.sha256,
                }),
                Err(error) if error.code == crate::ErrorCode::Cancelled => Err(error),
                Err(_) if locked(&path) => Err(locked_error(relative)),
                Err(_) => Ok(TargetCopy::Unreadable),
            }
        }
    }
}

/// What the source holds at a path, for the planner, with its size. A file
/// another program holds open is an error: the switch holds. A sensitive
/// entry reads as unreadable and stays in the source.
pub(crate) fn inspect_source(
    root: &Path,
    relative: &str,
    listings: &Listings,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<(SourceCopy, Option<u64>)> {
    let path = member(root, relative);
    if crate::runtime_data_policy::refuse_sensitive_entry(&path).is_err() {
        return Ok((SourceCopy::Unreadable, None));
    }
    match exact_parents(root, relative, listings)? {
        None => Ok((SourceCopy::Absent, None)),
        Some(false) => Ok((SourceCopy::Unreadable, None)),
        Some(true) => match hash_file(&path, checkpoint) {
            Ok(digest) => Ok((
                SourceCopy::File {
                    sha256: digest.sha256,
                },
                Some(digest.size),
            )),
            Err(error) if error.code == crate::ErrorCode::Cancelled => Err(error),
            Err(_) if locked(&path) => Err(locked_error(relative)),
            Err(_) => Ok((SourceCopy::Unreadable, None)),
        },
    }
}

/// Delete leftover temporary files from an interrupted carry under the
/// target's persistence root. Only regular files with the staging prefix are
/// removed; links and junctions are never followed.
pub(crate) fn sweep(root: &Path) -> Result<usize> {
    let mut removed = 0;
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries {
            let entry = entry?;
            let Ok(metadata) = fs::symlink_metadata(entry.path()) else {
                continue;
            };
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

/// Create the missing parents of `relative` one folder at a time, refusing to
/// pass through a link, a case variant or a non-directory (review finding 2).
fn create_parents(root: &Path, relative: &str) -> Result<Option<PathBuf>> {
    let parts = relative.split('/').collect::<Vec<_>>();
    let mut directory = root.to_path_buf();
    let mut walked = Vec::new();
    for part in &parts[..parts.len().saturating_sub(1)] {
        let next = directory.join(part);
        match fs::symlink_metadata(&next) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => {
                return Err(PortcoveError::conflict(
                    "a carried file's folder is not an ordinary folder",
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => fs::create_dir(&next)?,
            Err(error) => return Err(error.into()),
        }
        walked.push(*part);
        if exact_parents(root, &walked.join("/"), &Listings::default())? != Some(true) {
            // The filesystem resolved the name to a differently named folder
            // (a case alias): keep this file separately, never hold.
            return Ok(None);
        }
        directory = next;
    }
    crate::path::refuse_symlink_ancestors(&member(root, relative))?;
    Ok(Some(directory))
}

/// Stage on the destination's existing volume without creating its missing
/// folders. New descendants of that ancestor remain on that volume; an
/// intervening mount/replacement can only make publication fail, never turn
/// it into a non-atomic copy fallback.
fn staging_parent(root: &Path, relative: &str) -> Result<Option<PathBuf>> {
    let parts = relative.split('/').collect::<Vec<_>>();
    let mut directory = root.to_path_buf();
    let mut walked = Vec::new();
    for part in &parts[..parts.len().saturating_sub(1)] {
        walked.push(*part);
        match exact_parents(root, &walked.join("/"), &Listings::default())? {
            Some(false) => return Ok(None),
            None => break,
            Some(true) => {
                let next = directory.join(part);
                if !fs::symlink_metadata(&next)?.is_dir() {
                    return Ok(None);
                }
                directory = next;
            }
        }
    }
    crate::path::refuse_symlink_ancestors(&directory)?;
    Ok(Some(directory))
}

/// The sizes inspection found, for the space check and to bound each copy.
#[derive(Debug, Default)]
pub(crate) struct Inspected {
    pub(crate) sizes: BTreeMap<String, u64>,
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

/// A planned removal, with the destination as the verify pass saw it.
#[derive(Debug)]
struct StagedRemoval {
    path: String,
    destination: PathBuf,
    expected: String,
    seen: Option<(u64, SystemTime)>,
}

/// A staged and verified carry. Dropping it deletes every temporary file not
/// yet renamed into place.
#[derive(Debug)]
pub(crate) struct Staged {
    target_root: PathBuf,
    copies: Vec<StagedCopy>,
    /// How many of `copies`, in order, publishing has finished with.
    done: usize,
    removals: Vec<StagedRemoval>,
    /// Paths whose target changed since planning: the switch writes nothing
    /// there and records them as kept separately.
    pub(crate) changed_targets: Vec<String>,
}

impl Drop for Staged {
    fn drop(&mut self) {
        for copy in &self.copies[self.done.min(self.copies.len())..] {
            let _ = fs::remove_file(&copy.temporary);
        }
    }
}

impl Staged {
    /// Continuation after staging exhaustion requires confirmed cleanup.
    fn discard(&mut self) -> Result<()> {
        for copy in &self.copies[self.done.min(self.copies.len())..] {
            match fs::remove_file(&copy.temporary) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        self.done = self.copies.len();
        Ok(())
    }
}

fn destination_error(error: std::io::Error) -> CarryStop {
    if error.kind() == std::io::ErrorKind::StorageFull {
        CarryStop::StagingStorageFull
    } else {
        error.into()
    }
}

pub(crate) type StagingWriter<'a> = dyn Fn(&mut fs::File, &[u8]) -> std::io::Result<()> + 'a;

pub(crate) fn write_staging(output: &mut fs::File, bytes: &[u8]) -> std::io::Result<()> {
    output.write_all(bytes)
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

/// Attach the planned path to a stop that lacks one.
fn at(path: &str) -> impl Fn(CarryStop) -> CarryStop + '_ {
    move |stop| match stop {
        CarryStop::Locked(found) if found.is_empty() => CarryStop::Locked(path.to_owned()),
        CarryStop::SourceChanged(found) if found.is_empty() => {
            CarryStop::SourceChanged(path.to_owned())
        }
        other => other,
    }
}

/// Stage and verify every copy, replacement and removal in `plan`, against
/// the bytes the plan approved. `available` and `total` describe the
/// target's volume. Missing destination folders are created only during publish.
pub(crate) fn stage(
    (source_root, target_root): (&Path, &Path),
    plan: &[PlannedPath],
    inspected: &Inspected,
    (available, total): (u64, u64),
    checkpoint: &dyn Fn() -> Result<()>,
) -> std::result::Result<Staged, CarryStop> {
    stage_with_writer(
        (source_root, target_root),
        plan,
        inspected,
        (available, total),
        checkpoint,
        &write_staging,
    )
}

/// Destination writes remain injectable without changing source IO or publication.
pub(crate) fn stage_with_writer(
    (source_root, target_root): (&Path, &Path),
    plan: &[PlannedPath],
    inspected: &Inspected,
    (available, total): (u64, u64),
    checkpoint: &dyn Fn() -> Result<()>,
    writer: &StagingWriter<'_>,
) -> std::result::Result<Staged, CarryStop> {
    let required = required_bytes(plan, &inspected.sizes, total);
    let copying = plan
        .iter()
        .any(|planned| matches!(planned.action, CarryAction::Copy | CarryAction::Replace));
    if copying && required > available {
        return Err(CarryStop::InsufficientSpace {
            required,
            available: Some(available),
        });
    }
    let mut staged = Staged {
        target_root: target_root.to_path_buf(),
        copies: Vec::new(),
        done: 0,
        removals: Vec::new(),
        changed_targets: Vec::new(),
    };
    let result = (|| {
        for planned in plan {
            checkpoint()?;
            let replaces = match planned.action {
                CarryAction::Copy => None,
                CarryAction::Replace | CarryAction::Remove => {
                    Some(planned.approved_target.clone().ok_or_else(|| {
                        PortcoveError::state("a planned replacement has no approved bytes")
                    })?)
                }
                _ => continue,
            };
            let destination = member(target_root, &planned.path);
            if planned.action == CarryAction::Remove {
                staged.removals.push(StagedRemoval {
                    path: planned.path.clone(),
                    destination,
                    expected: replaces.unwrap_or_default(),
                    seen: None,
                });
                continue;
            }
            let expected = planned
                .approved_source
                .as_deref()
                .ok_or_else(|| PortcoveError::state("a planned copy has no approved bytes"))?;
            let Some(parent) = staging_parent(target_root, &planned.path)? else {
                staged.changed_targets.push(planned.path.clone());
                continue;
            };
            let mut output = tempfile::Builder::new()
                .prefix(STAGING_PREFIX)
                .tempfile_in(&parent)
                .map_err(destination_error)?;
            let source = member(source_root, &planned.path);
            let limit = inspected.sizes.get(&planned.path).copied().unwrap_or(0);
            let copied = (|| {
                let copied = copy_hashing(&source, output.as_file_mut(), limit, checkpoint, writer)
                    .map_err(at(&planned.path))?;
                if copied != expected {
                    return Err(CarryStop::SourceChanged(planned.path.clone()));
                }
                output.as_file().sync_all().map_err(destination_error)?;
                Ok(())
            })();
            if let Err(stop) = copied {
                output.close()?;
                return Err(stop);
            }
            let (_, temporary) = match output.keep() {
                Ok(kept) => kept,
                Err(error) => {
                    error.file.close()?;
                    return Err(destination_error(error.error));
                }
            };
            staged.copies.push(StagedCopy {
                path: planned.path.clone(),
                temporary,
                destination,
                replaces,
                seen: None,
            });
        }
        verify(&mut staged, source_root, plan, checkpoint)?;
        Ok(())
    })();
    if let Err(stop) = result {
        staged.discard()?;
        return Err(match stop {
            CarryStop::StagingStorageFull => CarryStop::InsufficientSpace {
                required,
                available: None,
            },
            other => other,
        });
    }
    Ok(staged)
}

fn copy_hashing(
    source: &Path,
    output: &mut fs::File,
    limit: u64,
    checkpoint: &dyn Fn() -> Result<()>,
    writer: &StagingWriter<'_>,
) -> std::result::Result<String, CarryStop> {
    use sha2::{Digest as _, Sha256};
    crate::runtime_data_policy::refuse_sensitive_entry(source)?;
    if locked(source) {
        return Err(CarryStop::Locked(String::new()));
    }
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
        // A source still growing past its planned size has changed; stop
        // before it can fill the disk.
        if total > limit {
            return Err(CarryStop::SourceChanged(String::new()));
        }
        hasher.update(&buffer[..count]);
        writer(output, &buffer[..count]).map_err(destination_error)?;
    }
    if total != before.len() || input.metadata()?.modified()? != before.modified()? {
        return Err(CarryStop::SourceChanged(String::new()));
    }
    if !crate::runtime_data_policy::set_and_check_modified_time(output, before.modified()?)
        .map_err(destination_error)?
    {
        return Err(PortcoveError::unsupported(
            "destination cannot preserve the exact player-data modification time",
        )
        .into());
    }
    Ok(hex::encode(hasher.finalize()))
}

/// Re-hash every source and destination against the plan (M4). A target that
/// changed moves to `changed_targets` and is left alone.
fn verify(
    staged: &mut Staged,
    source_root: &Path,
    plan: &[PlannedPath],
    checkpoint: &dyn Fn() -> Result<()>,
) -> std::result::Result<(), CarryStop> {
    let approved = plan
        .iter()
        .map(|planned| (planned.path.as_str(), planned))
        .collect::<BTreeMap<_, _>>();
    let mut changed = Vec::new();
    for copy in &mut staged.copies {
        let source = member(source_root, &copy.path);
        if locked(&source) {
            return Err(CarryStop::Locked(copy.path.clone()));
        }
        let digest = hash_file(&source, checkpoint).map_err(|error| {
            if error.code == crate::ErrorCode::Cancelled {
                CarryStop::Failed(error)
            } else {
                CarryStop::SourceChanged(copy.path.clone())
            }
        })?;
        if approved
            .get(copy.path.as_str())
            .and_then(|planned| planned.approved_source.as_deref())
            != Some(digest.sha256.as_str())
        {
            return Err(CarryStop::SourceChanged(copy.path.clone()));
        }
        let seen = snapshot(&copy.destination)?;
        let current = match seen {
            None => None,
            Some(_) => match hash_file(&copy.destination, checkpoint) {
                Ok(digest) => Some(digest.sha256),
                Err(error) if error.code == crate::ErrorCode::Cancelled => return Err(error.into()),
                Err(_) if locked(&copy.destination) => {
                    return Err(CarryStop::Locked(copy.path.clone()));
                }
                // A destination that can't be hashed now is kept separately.
                Err(_) => Some(String::new()),
            },
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
    for mut removal in staged.removals.drain(..) {
        let seen = snapshot(&removal.destination)?;
        let current = match seen {
            None => None,
            Some(_) => match hash_file(&removal.destination, checkpoint) {
                Ok(digest) => Some(digest.sha256),
                Err(error) if error.code == crate::ErrorCode::Cancelled => return Err(error.into()),
                Err(_) => None,
            },
        };
        match (seen, current) {
            (Some(seen), Some(current)) if current == removal.expected => {
                removal.seen = Some(seen);
                removals.push(removal);
            }
            // Already gone: nothing to remove.
            (None, _) => {}
            _ => changed.push(removal.path),
        }
    }
    staged.removals = removals;
    staged.changed_targets.extend(changed);
    Ok(())
}

impl Staged {
    /// The paths that will be written or removed.
    pub(crate) fn written(&self) -> Vec<&str> {
        self.copies
            .iter()
            .map(|copy| copy.path.as_str())
            .chain(self.removals.iter().map(|removal| removal.path.as_str()))
            .collect()
    }

    /// Whether a destination is still safe to write: its parents are exact
    /// folders without links and it is as the verify pass saw it.
    fn unchanged(
        &self,
        relative: &str,
        destination: &Path,
        seen: Option<(u64, SystemTime)>,
    ) -> Result<bool> {
        if crate::path::refuse_symlink_ancestors(destination).is_err() {
            return Ok(false);
        }
        let exact = exact_parents(&self.target_root, relative, &Listings::default())?;
        let parents_ok = match seen {
            Some(_) => exact == Some(true),
            None => exact.is_none(),
        };
        Ok(parents_ok && snapshot(destination)? == seen)
    }

    /// Rename every staged copy into place and make the planned removals.
    /// Not cancellable. A destination that changed since the verify pass is
    /// left alone and returned, to be recorded as kept separately. On an
    /// error, copies already renamed stay and the rest are deleted; the
    /// target must not be activated.
    pub(crate) fn publish(mut self) -> std::result::Result<Vec<String>, CarryStop> {
        let mut kept = Vec::new();
        while self.done < self.copies.len() {
            let copy = &self.copies[self.done];
            if !self.unchanged(&copy.path, &copy.destination, copy.seen)? {
                kept.push(copy.path.clone());
                let _ = fs::remove_file(&copy.temporary);
                self.done += 1;
                continue;
            }
            // Missing destination folders are created only after every copy
            // has staged and verified. A changed parent remains separate.
            if create_parents(&self.target_root, &copy.path)?.is_none()
                || !self.unchanged(&copy.path, &copy.destination, copy.seen)?
            {
                kept.push(copy.path.clone());
                let _ = fs::remove_file(&copy.temporary);
                self.done += 1;
                continue;
            }
            let publication = crate::durability::tempfile_destination(&copy.destination)?;
            if let Err(error) = fs::rename(&copy.temporary, &publication) {
                return Err(if is_held(&error) {
                    CarryStop::Locked(copy.path.clone())
                } else {
                    CarryStop::Failed(error.into())
                });
            }
            if let Some(parent) = copy.destination.parent() {
                let _ = crate::durability::sync_publication(parent);
            }
            self.done += 1;
        }
        for removal in std::mem::take(&mut self.removals) {
            if !self.unchanged(&removal.path, &removal.destination, removal.seen)? {
                kept.push(removal.path);
                continue;
            }
            if let Err(error) = fs::remove_file(&removal.destination) {
                return Err(if is_held(&error) {
                    CarryStop::Locked(removal.path)
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
