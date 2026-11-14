//! Concrete conventional-data and producing-archive coordinates. No source or
//! executable admission is inferred from a directory name.
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use crate::{PortDefinition, PortcoveError, Result};
use sha2::{Digest, Sha256};

const ROOT: &str = ".portcove-archive-data-v1";
const MAX_ENTRIES: usize = 4096;

fn held(message: &str) -> PortcoveError {
    PortcoveError::conflict(message)
        .with_known_cause(crate::failure::KnownFailureCause::PortableDataContractChanged)
}

pub(crate) fn validate(port: &PortDefinition) -> Result<()> {
    crate::archive_data_transition::validate_declaration(port)?;
    if port.archive_data_compatibility_v1.is_none() {
        return Ok(());
    }
    if port.release.provider != crate::ReleaseSource::Github {
        return Err(PortcoveError::usage(
            "new archive data policies require a provider-bound GitHub archive",
        ));
    }
    crate::managed_runtime_policy::validate_release_rules(port)?;
    validate_layout(port)
}

/// A receipt-admitted predecessor retains its Direct acquisition contract.
/// Layout validation never supplies that predecessor admission itself.
pub(crate) fn validate_layout(port: &PortDefinition) -> Result<()> {
    let Some(policy) = &port.archive_data_compatibility_v1 else {
        return Ok(());
    };
    if !crate::persistence::ready_staged_archive(port)
        || !port.persistent_file_patterns.is_empty()
        || policy.contract_id.is_empty()
        || policy.contract_id.len() > 128
        || !policy
            .contract_id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        || policy.shared_paths.is_empty()
        || policy.shared_paths.len() > 64
    {
        return Err(PortcoveError::usage(
            "archive data compatibility requires a concrete runtime-local GitHub archive and bounded conventional paths",
        ));
    }
    if policy.build_specific_progress_paths.len() > 64 {
        return Err(PortcoveError::usage(
            "archive progress paths exceed their bound",
        ));
    }
    for path in &policy.build_specific_progress_paths {
        crate::archive::validate_relative_path(path, false)?;
        if !port
            .persistent_paths
            .iter()
            .any(|root| Path::new(path).starts_with(root))
            || policy
                .shared_paths
                .iter()
                .any(|shared| Path::new(path).starts_with(shared))
        {
            return Err(PortcoveError::usage(
                "archive progress must be declared persistent data outside shared paths",
            ));
        }
    }
    for path in port.persistent_paths.iter().chain(&policy.shared_paths) {
        crate::archive::validate_relative_path(path, false)?;
        if path
            .split('/')
            .next()
            .is_some_and(|p| p.eq_ignore_ascii_case(ROOT))
        {
            return Err(PortcoveError::usage(
                "persistent paths overlap reserved archive data",
            ));
        }
    }
    for (index, path) in policy.shared_paths.iter().enumerate() {
        if !port
            .persistent_paths
            .iter()
            .any(|root| Path::new(path).starts_with(root))
            || policy.shared_paths[..index].iter().any(|other| {
                let a = path.to_lowercase();
                let b = other.to_lowercase();
                Path::new(&a).starts_with(&b) || Path::new(&b).starts_with(&a)
            })
        {
            return Err(PortcoveError::usage(
                "conventional data paths must be disjoint subsets of declared persistence",
            ));
        }
    }
    if let Some(original) = &port.runtime_source_filename
        && !policy.shared_paths.contains(original)
    {
        return Err(PortcoveError::usage(
            "verified original data must retain its canonical coordinate",
        ));
    }
    Ok(())
}

pub(crate) fn policy_sha256(port: &PortDefinition) -> Result<String> {
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(&(
        &port.id,
        &port.archive_data_compatibility_v1,
        &port.persistent_paths,
        &port.source_profile,
        &port.runtime_source_filename,
        &port.runtime_source_hashes,
    ))?)))
}

fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Staged-source reader capability that understands additive data-policy
/// successors. Indexed definitions that append to a policy require it, so an
/// older reader refuses the entry instead of holding existing installations.
pub(crate) const ADDITIVE_DATA_POLICY_CAPABILITY: u32 = 34;

/// Shared paths are bounded at 64 and one must remain, so at most 63 files can
/// be appended across a whole lineage.
const MAX_APPENDED_PATHS: usize = 63;
const MAX_ADOPTED_FILE_BYTES: u64 = 16 * 1024 * 1024;

/// Lengths of the trailing runs that structurally separate `port` from each of
/// its additive predecessors, nearest first. No definition is cloned.
///
/// A successor may only append the same non-empty run of conventional files to
/// the end of both `persistent_paths` and `shared_paths`. Removing that run
/// must leave every other hashed coordinate (port, contract, progress paths,
/// source identity and every existing path, in order) unchanged. An appended
/// path is a file name with an extension, is not an executable companion on any
/// declared platform, is not the verified original, and may not equal, contain
/// or sit inside an existing persistent, shared or progress path, so no
/// preserved object is reinterpreted. No catalog record names a predecessor.
pub(crate) fn additive_runs(port: &PortDefinition) -> Vec<usize> {
    let Some(policy) = &port.archive_data_compatibility_v1 else {
        return Vec::new();
    };
    let persistent = port.persistent_paths.len();
    let shared = policy.shared_paths.len();
    let longest = shared
        .min(persistent)
        .saturating_sub(1)
        .min(MAX_APPENDED_PATHS);
    let mut result = Vec::new();
    for count in 1..=longest {
        let added = &port.persistent_paths[persistent - count..];
        let kept_persistent = &port.persistent_paths[..persistent - count];
        let kept_shared = &policy.shared_paths[..shared - count];
        if added != &policy.shared_paths[shared - count..]
            || added.iter().any(|path| {
                !file_like(path)
                    || port.platforms.iter().any(|platform| {
                        crate::install::is_executable_companion_name(Path::new(path), *platform)
                    })
                    || port.runtime_source_filename.as_deref() == Some(path.as_str())
                    || policy
                        .build_specific_progress_paths
                        .iter()
                        .chain(kept_persistent)
                        .chain(kept_shared)
                        .any(|existing| overlaps(path, existing))
            })
        {
            // Every longer run contains this one, so none can be additive.
            break;
        }
        result.push(count);
    }
    result
}

fn file_like(path: &str) -> bool {
    let path = Path::new(path);
    path.extension().is_some_and(|e| !e.is_empty())
        && path.file_stem().is_some_and(|s| !s.is_empty())
}

fn truncated(port: &PortDefinition, count: usize) -> PortDefinition {
    let mut predecessor = port.clone();
    predecessor
        .persistent_paths
        .truncate(port.persistent_paths.len() - count);
    let policy = predecessor
        .archive_data_compatibility_v1
        .as_mut()
        .expect("checked policy");
    let shared = policy.shared_paths.len();
    policy.shared_paths.truncate(shared - count);
    predecessor
}

/// The policy hash of the predecessor `count` appended files away, computed
/// from the same serialized coordinates as [`policy_sha256`] without a clone.
fn predecessor_sha256(port: &PortDefinition, count: usize) -> Result<String> {
    let policy = port
        .archive_data_compatibility_v1
        .as_ref()
        .expect("checked policy");
    let kept = crate::ArchiveDataCompatibilityV1 {
        contract_id: policy.contract_id.clone(),
        shared_paths: policy.shared_paths[..policy.shared_paths.len() - count].to_vec(),
        build_specific_progress_paths: policy.build_specific_progress_paths.clone(),
    };
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(&(
        &port.id,
        Some(&kept),
        &port.persistent_paths[..port.persistent_paths.len() - count],
        &port.source_profile,
        &port.runtime_source_filename,
        &port.runtime_source_hashes,
    ))?)))
}

/// Predecessor definitions, nearest first, each checked as a full layout.
/// Production code uses the count-based helpers; this clones per predecessor.
#[cfg(test)]
pub(crate) fn additive_predecessors(port: &PortDefinition) -> Vec<PortDefinition> {
    additive_runs(port)
        .into_iter()
        .map(|count| truncated(port, count))
        .filter(|predecessor| validate_layout(predecessor).is_ok())
        .collect()
}

fn overlaps(a: &str, b: &str) -> bool {
    let a = a.to_lowercase();
    let b = b.to_lowercase();
    Path::new(&a).starts_with(&b) || Path::new(&b).starts_with(&a)
}

fn run_for_policy(port: &PortDefinition, policy: &str) -> Result<Option<usize>> {
    for count in additive_runs(port) {
        if predecessor_sha256(port, count)? == policy {
            return Ok(Some(count));
        }
    }
    Ok(None)
}

/// The conventional files `successor` appends to `predecessor`, when it is a
/// structural additive successor of that exact policy.
pub(crate) fn added_paths(
    predecessor: &PortDefinition,
    successor: &PortDefinition,
) -> Result<Option<Vec<String>>> {
    if predecessor.archive_data_compatibility_v1.is_none()
        || successor.archive_data_compatibility_v1.is_none()
        || validate_layout(successor).is_err()
    {
        return Ok(None);
    }
    Ok(
        run_for_policy(successor, &policy_sha256(predecessor)?)?.map(|count| {
            successor.persistent_paths[successor.persistent_paths.len() - count..].to_vec()
        }),
    )
}

/// Equal policies, or one an additive successor of the other.
pub(crate) fn same_lineage(a: &PortDefinition, b: &PortDefinition) -> Result<bool> {
    if a.archive_data_compatibility_v1.is_none() || b.archive_data_compatibility_v1.is_none() {
        return Ok(false);
    }
    Ok(policy_sha256(a)? == policy_sha256(b)?
        || added_paths(a, b)?.is_some()
        || added_paths(b, a)?.is_some())
}

/// `to` keeps `from`'s policy or is its additive successor (never the reverse).
pub(crate) fn same_or_successor(from: &PortDefinition, to: &PortDefinition) -> Result<bool> {
    if from.archive_data_compatibility_v1.is_none() || to.archive_data_compatibility_v1.is_none() {
        return Ok(false);
    }
    Ok(policy_sha256(from)? == policy_sha256(to)? || added_paths(from, to)?.is_some())
}

/// The lineage member of `port` (itself or a predecessor) with this policy.
pub(crate) fn lineage_member(
    port: &PortDefinition,
    policy: &str,
) -> Result<Option<PortDefinition>> {
    if port.archive_data_compatibility_v1.is_none() {
        return Ok(None);
    }
    if policy_sha256(port)? == policy {
        return Ok(Some(port.clone()));
    }
    Ok(run_for_policy(port, policy)?.map(|count| truncated(port, count)))
}

/// The lineage member of `port` whose persistence scope is exactly `paths`.
pub(crate) fn lineage_member_with_paths(
    port: &PortDefinition,
    paths: &[String],
) -> Option<PortDefinition> {
    if port.persistent_paths == paths {
        return Some(port.clone());
    }
    additive_runs(port)
        .into_iter()
        .find(|count| {
            port.persistent_paths.len() - count == paths.len()
                && port.persistent_paths[..paths.len()] == *paths
        })
        .map(|count| truncated(port, count))
}

/// Whether an existing namespace or snapshot framing belongs to this policy or
/// one of its structural predecessors.
pub(crate) fn accepts_policy(port: &PortDefinition, policy: &str) -> Result<bool> {
    if port.archive_data_compatibility_v1.is_none() {
        return Ok(false);
    }
    Ok(policy_sha256(port)? == policy || run_for_policy(port, policy)?.is_some())
}

/// Appended files a snapshot framed by a strict predecessor policy does not
/// cover. A restore keeps the current files at these paths when the snapshot
/// lacks them, instead of deleting them.
pub(crate) fn uncovered_added_paths(port: &PortDefinition, root: &Path) -> Result<Vec<String>> {
    if port.archive_data_compatibility_v1.is_none() {
        return Ok(Vec::new());
    }
    let Some(framing) = snapshot_policy(root)? else {
        return Ok(Vec::new());
    };
    if framing == policy_sha256(port)? {
        return Ok(Vec::new());
    }
    Ok(run_for_policy(port, &framing)?
        .map(|count| port.persistent_paths[port.persistent_paths.len() - count..].to_vec())
        .unwrap_or_default())
}

/// A successor keeps the namespace its predecessor established, so archive-
/// bound objects and older readers keep their exact coordinates.
pub(crate) fn namespace(port: &PortDefinition, user_root: &Path) -> Result<PathBuf> {
    let current = policy_sha256(port)?;
    let base = user_root.join(ROOT);
    let mut names = Vec::new();
    match fs::read_dir(&base) {
        Ok(entries) => {
            for entry in entries.take(2) {
                names.push(entry?.file_name());
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    if let [name] = names.as_slice()
        && let Some(name) = name.to_str()
        && name != current
        && digest(name)
        && accepts_policy(port, name)?
    {
        return Ok(base.join(name));
    }
    Ok(base.join(current))
}

/// An ordinary regular file's digest, or none when absent. Anything else at
/// an appended file coordinate holds for review.
fn appended_file(root: &Path, relative: &str) -> Result<Option<String>> {
    crate::persistence::require_exact_path(root, relative)?;
    let path = root.join(relative);
    crate::path::refuse_symlink_ancestors(&path)?;
    let metadata = match fs::symlink_metadata(&path) {
        Ok(value) => value,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    if !metadata.is_file() || metadata.len() > MAX_ADOPTED_FILE_BYTES {
        return Err(held(
            "a newly declared settings file is not an ordinary bounded file; preserve it and review the installation",
        )
        .detail("path", relative));
    }
    Ok(Some(
        crate::external_runtime::hash_stable_regular(&path, MAX_ADOPTED_FILE_BYTES, &|| Ok(()))?.0,
    ))
}

/// Read-only preflight for a successor's appended files. Returns the files the
/// active predecessor runtime holds and canonical data lacks. When both hold a
/// file with different bytes, the player must choose: that holds.
pub(crate) fn require_adoptable(
    predecessor: &PortDefinition,
    successor: &PortDefinition,
    runtime: &Path,
    user: &Path,
) -> Result<Vec<String>> {
    let Some(added) = added_paths(predecessor, successor)? else {
        return Ok(Vec::new());
    };
    let mut adoptable = Vec::new();
    for relative in added {
        match (
            appended_file(runtime, &relative)?,
            appended_file(user, &relative)?,
        ) {
            (Some(active), Some(canonical)) if active != canonical => {
                return Err(held(
                    "the current version and saved data hold different copies of a newly declared settings file; keep the one you want and review the update again",
                )
                .detail("path", relative.as_str()));
            }
            (Some(_), None) => adoptable.push(relative),
            _ => {}
        }
    }
    Ok(adoptable)
}

/// After the successor copy's ordinary restore, give its appended files their
/// initial content from the active predecessor runtime where canonical data
/// has none. Only the successor copy is written: canonical data gains the files
/// through the successor's own later collection, so an interrupted activation
/// leaves no canonical change behind. Returns the adopted relative paths.
pub(crate) fn adopt_added_paths(
    predecessor: &PortDefinition,
    successor: &PortDefinition,
    runtime: &Path,
    user: &Path,
    target: &Path,
) -> Result<Vec<String>> {
    let adoptable = require_adoptable(predecessor, successor, runtime, user)?;
    for relative in &adoptable {
        if appended_file(target, relative)?.is_some() {
            return Err(held(
                "the new version already holds a newly declared settings file that saved data lacks; preserve it and review the update",
            )
            .detail("path", relative.as_str()));
        }
        let destination = target.join(relative);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        crate::runtime_data_policy::copy_ordinary_file(&runtime.join(relative), &destination)?;
    }
    Ok(adoptable)
}

/// Coordinates and content framing only; never runtime or source admission.
pub(crate) fn snapshot_policy(root: &Path) -> Result<Option<String>> {
    crate::persistence::require_exact_path(root, ROOT)?;
    let base = root.join(ROOT);
    let directories = match fs::read_dir(&base) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let mut policy = None;
    for entry in directories {
        let entry = entry?;
        let name = crate::path::unicode(Path::new(&entry.file_name()), "data policy coordinate")?;
        if policy.is_some() || !digest(&name) || !entry.file_type()?.is_dir() {
            return Err(held(
                "partitioned snapshot has an invalid policy coordinate",
            ));
        }
        for (count, archive) in fs::read_dir(entry.path())?.enumerate() {
            let archive = archive?;
            if count >= MAX_ENTRIES
                || !archive.file_type()?.is_dir()
                || archive
                    .file_name()
                    .to_str()
                    .is_none_or(|name| !digest(name))
            {
                return Err(held(
                    "partitioned snapshot has an invalid archive coordinate",
                ));
            }
        }
        policy = Some(name);
    }
    Ok(policy)
}

pub(crate) fn has_bound_objects(root: &Path) -> Result<bool> {
    let mut remaining = MAX_ENTRIES;
    has_files(&root.join(ROOT), &mut remaining)
}

pub(crate) fn initialize(port: &PortDefinition, user_root: &Path) -> Result<()> {
    if port.archive_data_compatibility_v1.is_some() {
        require_snapshot(port, user_root)?;
        let path = namespace(port, user_root)?;
        crate::path::refuse_symlink_ancestors(&path)?;
        fs::create_dir_all(path)?;
    }
    Ok(())
}

/// Snapshot integrity/admission belongs to the caller. This checks only that
/// its data layout does not silently borrow a different compatibility policy.
pub(crate) fn require_snapshot(port: &PortDefinition, root: &Path) -> Result<()> {
    if port.archive_data_compatibility_v1.is_none() {
        return Ok(());
    }
    crate::persistence::require_exact_path(root, ROOT)?;
    let base = root.join(ROOT);
    crate::path::refuse_symlink_ancestors(&base)?;
    let directories = match fs::read_dir(&base) {
        Ok(entries) => Some(entries),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.into()),
    };
    let mut established = false;
    for (count, entry) in directories.into_iter().flatten().enumerate() {
        let entry = entry?;
        // The established namespace may belong to a structural predecessor.
        let name = entry.file_name();
        let accepted = match name.to_str() {
            Some(name) => digest(name) && accepts_policy(port, name)?,
            None => false,
        };
        if count > 0 || !accepted || !entry.file_type()?.is_dir() {
            return Err(held(
                "saved data belongs to another compatibility contract; preserve its runtime and data",
            ));
        }
        established = true;
        for (count, archive) in fs::read_dir(entry.path())?.enumerate() {
            let archive = archive?;
            if count >= MAX_ENTRIES
                || !archive.file_type()?.is_dir()
                || archive
                    .file_name()
                    .to_str()
                    .is_none_or(|name| !digest(name))
            {
                return Err(held(
                    "archive-bound player data has an invalid producing archive coordinate",
                ));
            }
        }
    }
    let mut remaining = MAX_ENTRIES;
    for relative in &port.persistent_paths {
        require_raw(port, root, relative, established, &mut remaining)?;
    }
    Ok(())
}

fn require_raw(
    port: &PortDefinition,
    root: &Path,
    relative: &str,
    established: bool,
    remaining: &mut usize,
) -> Result<()> {
    *remaining = remaining
        .checked_sub(1)
        .ok_or_else(|| held("snapshot inspection exceeds its bound"))?;
    let path = root.join(relative);
    crate::persistence::require_exact_path(root, relative)?;
    crate::path::refuse_symlink_ancestors(&path)?;
    let metadata = match fs::symlink_metadata(&path) {
        Ok(value) => value,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
    };
    let policy = port
        .archive_data_compatibility_v1
        .as_ref()
        .expect("checked policy");
    if policy
        .shared_paths
        .iter()
        .any(|p| Path::new(relative).starts_with(p))
    {
        if port.runtime_source_filename.as_deref() == Some(relative) {
            let expected = port
                .runtime_source_hashes
                .get(relative)
                .ok_or_else(|| held("original data has no retained expected identity"))?;
            if crate::external_runtime::hash_stable_regular(&path, 16 * 1024 * 1024, &|| Ok(()))?.0
                != *expected
            {
                return Err(held(
                    "preserved original data differs from its retained expected identity",
                ));
            }
        }
        if !established && port.runtime_source_filename.as_deref() != Some(relative) {
            return Err(held(
                "preserved conventional data has no creating compatibility contract; keep its working runtime",
            ));
        }
        return Ok(());
    }
    if !metadata.is_dir()
        || !policy
            .shared_paths
            .iter()
            .any(|p| Path::new(p).starts_with(relative))
    {
        return Err(held(
            "unbound preserved player data cannot be assigned to a new runtime; keep the creating installation",
        ));
    }
    for child in fs::read_dir(path)? {
        let child = child?;
        let name = crate::path::unicode(Path::new(&child.file_name()), "snapshot data entry")?;
        require_raw(
            port,
            root,
            &format!("{relative}/{name}"),
            established,
            remaining,
        )?;
    }
    Ok(())
}

pub(crate) fn refuse_unpartitioned_snapshot(root: &Path) -> Result<()> {
    let path = root.join(ROOT);
    crate::path::refuse_symlink_ancestors(&path)?;
    if fs::symlink_metadata(path).is_ok() {
        return Err(held(
            "archive-bound snapshots require their retained partitioned-data reader",
        ));
    }
    Ok(())
}

pub(crate) struct Entry {
    pub relative: String,
    pub canonical: PathBuf,
}

pub(crate) fn preservation_notices(port: &PortDefinition) -> Vec<String> {
    let Some(policy) = &port.archive_data_compatibility_v1 else {
        return Vec::new();
    };
    vec![format!(
        "Compatible updates preserve conventional data: {}. Quickstates, snapshots, replay sidecars and other archive-specific data stay with their creating runtime. They are not loaded by a different build. If your latest progress exists only in a quickstate, choosing the new runtime may start earlier or without that progress; keep using the previous version from Versions when needed. Updates with existing build-specific progress are staged for your review. Runtime rollback does not rewind saves or guarantee an older runtime can read newer data.",
        policy.shared_paths.join(", ")
    )]
}

pub(crate) fn progress_requires_choice(
    port: &PortDefinition,
    archive: &str,
    runtime: &Path,
    user: &Path,
) -> Result<bool> {
    let Some(policy) = &port.archive_data_compatibility_v1 else {
        return Ok(false);
    };
    let mapped = entries(port, Some(archive), runtime, user)?;
    let mut remaining = MAX_ENTRIES;
    for entry in mapped {
        if entry.canonical == user.join(&entry.relative)
            || !policy
                .build_specific_progress_paths
                .iter()
                .any(|p| Path::new(&entry.relative).starts_with(p))
        {
            continue;
        }
        if has_files(&runtime.join(&entry.relative), &mut remaining)?
            || has_files(&entry.canonical, &mut remaining)?
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn has_files(path: &Path, remaining: &mut usize) -> Result<bool> {
    *remaining = remaining
        .checked_sub(1)
        .ok_or_else(|| held("progress inspection exceeds its bound"))?;
    crate::path::refuse_symlink_ancestors(path)?;
    let metadata = match fs::symlink_metadata(path) {
        Ok(value) => value,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e.into()),
    };
    if metadata.is_file() {
        return Ok(true);
    }
    if !metadata.is_dir() {
        return Err(held("progress is not an ordinary file or directory"));
    }
    for child in fs::read_dir(path)? {
        if has_files(&child?.path(), remaining)? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Compute the complete bounded mapping before the caller copies anything.
/// Mixed directories split only at explicit conventional-path boundaries;
/// unknown children always stay with the producing archive.
pub(crate) fn entries(
    port: &PortDefinition,
    archive: Option<&str>,
    runtime: &Path,
    user: &Path,
) -> Result<Vec<Entry>> {
    let Some(policy) = &port.archive_data_compatibility_v1 else {
        return Ok(crate::persistence::entries(port, &[runtime, user])?
            .into_iter()
            .map(|relative| Entry {
                canonical: user.join(&relative),
                relative,
            })
            .collect());
    };
    validate_layout(port)?;
    let archive = archive.filter(|sha| digest(sha)).ok_or_else(|| {
        held("partitioned data requires its actual retained installation and archive identity")
    })?;
    require_snapshot(port, user)?;
    let bound = namespace(port, user)?.join(archive);
    let mut mapping = Mapping {
        policy,
        roots: [runtime, user, &bound],
        user,
        bound: &bound,
        remaining: MAX_ENTRIES,
        result: Vec::new(),
    };
    for relative in &port.persistent_paths {
        mapping.split(relative)?;
    }
    Ok(mapping.result)
}

struct Mapping<'a> {
    policy: &'a crate::ArchiveDataCompatibilityV1,
    roots: [&'a Path; 3],
    user: &'a Path,
    bound: &'a Path,
    remaining: usize,
    result: Vec<Entry>,
}

impl Mapping<'_> {
    fn charge(&mut self) -> Result<()> {
        self.remaining = self
            .remaining
            .checked_sub(1)
            .ok_or_else(|| held("partitioned data inspection exceeds its bound"))?;
        Ok(())
    }

    fn split(&mut self, relative: &str) -> Result<()> {
        self.charge()?;
        for root in self.roots {
            crate::persistence::require_exact_path(root, relative)?;
        }
        let shared = self
            .policy
            .shared_paths
            .iter()
            .any(|p| Path::new(relative).starts_with(p));
        let mixed = !shared
            && self
                .policy
                .shared_paths
                .iter()
                .any(|p| Path::new(p).starts_with(relative));
        if !mixed {
            if !shared && self.user.join(relative).try_exists()? {
                return Err(held(
                    "unbound preserved player data cannot be assigned to a new runtime; keep the creating installation",
                ));
            }
            self.result.push(Entry {
                relative: relative.into(),
                canonical: if shared { self.user } else { self.bound }.join(relative),
            });
            return Ok(());
        }
        let mut names = BTreeMap::<String, String>::new();
        for root in self.roots {
            let path = root.join(relative);
            crate::path::refuse_symlink_ancestors(&path)?;
            let children = match fs::read_dir(&path) {
                Ok(entries) => entries,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(e.into()),
            };
            for child in children {
                let child = child?;
                self.charge()?;
                if child.file_type()?.is_symlink() {
                    return Err(held("partitioned data crosses a link"));
                }
                let name =
                    crate::path::unicode(Path::new(&child.file_name()), "player-data entry")?;
                if names
                    .insert(name.to_lowercase(), name.clone())
                    .is_some_and(|prior| prior != name)
                {
                    return Err(held("partitioned data has a case alias"));
                }
            }
        }
        for name in names.values() {
            self.split(&format!("{relative}/{name}"))?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn port() -> PortDefinition {
        let mut port = crate::Catalog::embedded()
            .unwrap()
            .port("super-metroid-recomp")
            .unwrap()
            .clone();
        port.release.provider = crate::ReleaseSource::Github;
        port.release.repository = "mstan/SuperMetroidRecomp".into();
        port.release.direct.clear();
        port.release.asset_hints.insert(
            crate::Platform::WindowsX86_64,
            vec!["supermetroid-".into(), "-windows-x64.zip".into()],
        );
        port.archive_data_compatibility_v1 = Some(crate::ArchiveDataCompatibilityV1 {
            contract_id: "super-metroid-conventional-v1".into(),
            shared_paths: vec![
                "game.sfc".into(),
                "config.ini".into(),
                "keybinds.ini".into(),
                "saves/save.srm".into(),
            ],
            build_specific_progress_paths: vec!["saves".into()],
        });
        port
    }

    #[test]
    fn partitioned_archive_data_splits_sram_from_snapshots_and_unknown_files() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let runtime = directory.path().join("runtime");
        let user = directory.path().join("user");
        fs::create_dir_all(runtime.join("saves"))?;
        fs::write(runtime.join("saves/save.srm"), b"guest SRAM")?;
        fs::write(runtime.join("saves/save1.sav"), b"host snapshot")?;
        fs::write(
            runtime.join("saves/unknown.dat"),
            b"unknown preserved object",
        )?;
        let port = port();
        let archive = "a".repeat(64);
        let mapped = entries(&port, Some(&archive), &runtime, &user)?;
        let find = |name: &str| {
            &mapped
                .iter()
                .find(|e| e.relative == name)
                .unwrap()
                .canonical
        };
        assert_eq!(find("saves/save.srm"), &user.join("saves/save.srm"));
        let bound = namespace(&port, &user)?.join(&archive);
        assert_eq!(find("saves/save1.sav"), &bound.join("saves/save1.sav"));
        assert_eq!(find("saves/unknown.dat"), &bound.join("saves/unknown.dat"));
        let next = entries(&port, Some(&"b".repeat(64)), &runtime, &user)?;
        assert_eq!(
            next.iter()
                .find(|e| e.relative == "saves/save.srm")
                .unwrap()
                .canonical,
            user.join("saves/save.srm")
        );
        assert_ne!(
            next.iter()
                .find(|e| e.relative == "saves/save1.sav")
                .unwrap()
                .canonical,
            *find("saves/save1.sav")
        );
        assert!(!user.exists(), "mapping is a non-writing preflight");
        Ok(())
    }

    #[test]
    fn partitioned_archive_data_refuses_missing_producer_unbound_history_and_changed_policy()
    -> Result<()> {
        let directory = tempfile::tempdir()?;
        let runtime = directory.path().join("runtime");
        let user = directory.path().join("user");
        let port = port();
        assert!(entries(&port, None, &runtime, &user).is_err());
        initialize(&port, &user)?;
        fs::create_dir_all(user.join("saves"))?;
        fs::write(user.join("saves/save1.sav"), b"unbound historical snapshot")?;
        assert!(entries(&port, Some(&"a".repeat(64)), &runtime, &user).is_err());
        assert_eq!(
            fs::read(user.join("saves/save1.sav"))?,
            b"unbound historical snapshot"
        );
        fs::remove_file(user.join("saves/save1.sav"))?;
        let mut changed = port.clone();
        changed
            .archive_data_compatibility_v1
            .as_mut()
            .unwrap()
            .contract_id = "another-contract".into();
        assert!(require_snapshot(&changed, &user).is_err());
        assert!(refuse_unpartitioned_snapshot(&user).is_err());
        Ok(())
    }

    fn successor(port: &PortDefinition, added: &[&str]) -> PortDefinition {
        let mut next = port.clone();
        for path in added {
            next.persistent_paths.push((*path).into());
            next.archive_data_compatibility_v1
                .as_mut()
                .unwrap()
                .shared_paths
                .push((*path).into());
        }
        next
    }

    #[test]
    fn additive_successor_lineage_is_derived_from_the_contract_alone() -> Result<()> {
        let base = port();
        let next = successor(&base, &["sound.ini", "fixes.ini"]);
        validate(&next)?;
        assert_eq!(
            added_paths(&base, &next)?,
            Some(vec!["sound.ini".into(), "fixes.ini".into()])
        );
        assert_eq!(added_paths(&next, &base)?, None, "removal is not additive");
        assert!(same_or_successor(&base, &next)?);
        assert!(!same_or_successor(&next, &base)?);
        assert!(same_lineage(&next, &base)?);
        // A chain of successors still reaches every earlier policy.
        let third = successor(&next, &["access.ini"]);
        // Every count-based run is a fully valid predecessor layout.
        assert_eq!(additive_runs(&third), [1, 2, 3]);
        assert_eq!(
            additive_predecessors(&third)
                .iter()
                .map(|p| p.persistent_paths.len())
                .collect::<Vec<_>>(),
            [
                next.persistent_paths.len(),
                next.persistent_paths.len() - 1,
                base.persistent_paths.len()
            ]
        );
        assert_eq!(added_paths(&base, &third)?.unwrap().len(), 3);
        assert_eq!(added_paths(&next, &third)?.unwrap(), ["access.ini"]);
        assert!(accepts_policy(&third, &policy_sha256(&base)?)?);
        assert_eq!(
            lineage_member(&third, &policy_sha256(&next)?)?
                .unwrap()
                .persistent_paths,
            next.persistent_paths
        );
        assert_eq!(
            lineage_member_with_paths(&third, &base.persistent_paths)
                .unwrap()
                .archive_data_compatibility_v1,
            base.archive_data_compatibility_v1
        );
        // Siblings share no lineage.
        let sibling = successor(&base, &["other.ini"]);
        assert!(!same_lineage(&next, &sibling)?);
        assert!(!accepts_policy(&sibling, &policy_sha256(&next)?)?);
        Ok(())
    }

    #[test]
    fn non_additive_policy_changes_remain_migrations() -> Result<()> {
        let base = port();
        let mut cases = Vec::new();
        // Persistent but not shared: archive-bound, not a settings file.
        let mut unshared = base.clone();
        unshared.persistent_paths.push("sound.ini".into());
        cases.push(unshared);
        // Removed and renamed paths.
        let mut removed = base.clone();
        removed.persistent_paths.retain(|p| p != "keybinds.ini");
        removed
            .archive_data_compatibility_v1
            .as_mut()
            .unwrap()
            .shared_paths
            .retain(|p| p != "keybinds.ini");
        cases.push(removed.clone());
        cases.push(successor(&removed, &["keybinds2.ini"]));
        // Re-scoped: a new shared file inside an existing mixed directory.
        cases.push(successor(&base, &["saves/settings.ini"]));
        // Inserted rather than appended.
        let mut inserted = successor(&base, &["sound.ini"]);
        inserted.persistent_paths.rotate_right(1);
        cases.push(inserted);
        // Any other hashed contract field.
        let mut contract = successor(&base, &["sound.ini"]);
        contract
            .archive_data_compatibility_v1
            .as_mut()
            .unwrap()
            .contract_id = "another-contract".into();
        cases.push(contract);
        let mut progress = successor(&base, &["sound.ini"]);
        progress
            .archive_data_compatibility_v1
            .as_mut()
            .unwrap()
            .build_specific_progress_paths
            .clear();
        cases.push(progress);
        let mut source = successor(&base, &["sound.ini"]);
        source
            .runtime_source_hashes
            .insert("game.sfc".into(), "b".repeat(64));
        cases.push(source);
        for (index, case) in cases.iter().enumerate() {
            assert_eq!(added_paths(&base, case)?, None, "case {index}");
            assert!(!same_or_successor(&base, case)?, "case {index}");
            assert!(
                !accepts_policy(case, &policy_sha256(&base)?)?,
                "case {index}"
            );
        }
        Ok(())
    }

    #[test]
    fn successor_keeps_predecessor_namespace_and_rollback_mapping() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let old_runtime = directory.path().join("old");
        let new_runtime = directory.path().join("new");
        let user = directory.path().join("user");
        let base = port();
        let next = successor(&base, &["sound.ini"]);
        let archive = "a".repeat(64);
        // An existing installation established the predecessor namespace.
        initialize(&base, &user)?;
        let established = namespace(&base, &user)?;
        fs::create_dir_all(established.join(&archive).join("saves"))?;
        fs::write(established.join(&archive).join("saves/save1.sav"), b"bound")?;
        fs::create_dir_all(&old_runtime)?;
        fs::write(old_runtime.join("sound.ini"), b"runtime choice")?;
        // Update: the successor reads the same namespace and owns the new file.
        require_snapshot(&next, &user)?;
        assert_eq!(namespace(&next, &user)?, established);
        initialize(&next, &user)?;
        assert_eq!(
            fs::read_dir(user.join(ROOT))?.count(),
            1,
            "no second namespace"
        );
        // Adoption writes only the new copy, never canonical data, so an
        // activation that fails afterwards leaves no stale canonical snapshot.
        assert_eq!(
            adopt_added_paths(&base, &next, &old_runtime, &user, &new_runtime)?,
            ["sound.ini"]
        );
        assert_eq!(fs::read(new_runtime.join("sound.ini"))?, b"runtime choice");
        assert!(!user.join("sound.ini").exists());
        // The new copy's collection later makes it canonical.
        fs::write(user.join("sound.ini"), b"runtime choice")?;
        let mapped = entries(&next, Some(&"b".repeat(64)), &new_runtime, &user)?;
        assert!(
            mapped
                .iter()
                .any(|e| e.relative == "sound.ini" && e.canonical == user.join("sound.ini"))
        );
        // Equal copies need nothing; differing copies wait for the player.
        let elsewhere = directory.path().join("elsewhere");
        assert!(adopt_added_paths(&base, &next, &old_runtime, &user, &elsewhere)?.is_empty());
        fs::write(old_runtime.join("sound.ini"), b"older runtime choice")?;
        let held = require_adoptable(&base, &next, &old_runtime, &user).unwrap_err();
        assert_eq!(
            held.details.get("path").map(String::as_str),
            Some("sound.ini")
        );
        assert!(adopt_added_paths(&base, &next, &old_runtime, &user, &elsewhere).is_err());
        assert!(!elsewhere.exists());
        assert_eq!(fs::read(user.join("sound.ini"))?, b"runtime choice");
        // Rollback: the predecessor maps only its own coordinates and still
        // finds its archive-bound objects; the successor's file stays canonical.
        let previous = entries(&base, Some(&archive), &old_runtime, &user)?;
        assert!(previous.iter().all(|e| e.relative != "sound.ini"));
        assert!(previous.iter().any(|e| e.relative == "saves/save1.sav"
            && e.canonical == established.join(&archive).join("saves/save1.sav")));
        require_snapshot(&base, &user)?;
        assert_eq!(fs::read(user.join("sound.ini"))?, b"runtime choice");
        // Restore: predecessor framing is accepted by every successor of that
        // predecessor; a changed contract still refuses the namespace.
        assert!(accepts_policy(&next, &snapshot_policy(&user)?.unwrap())?);
        assert!(require_snapshot(&successor(&base, &["other.ini"]), &user).is_ok());
        let mut changed = next.clone();
        changed
            .archive_data_compatibility_v1
            .as_mut()
            .unwrap()
            .contract_id = "another-contract".into();
        assert!(require_snapshot(&changed, &user).is_err());
        Ok(())
    }

    #[test]
    fn a_fresh_successor_namespace_is_not_readable_by_its_predecessor() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let user = directory.path().join("user");
        let base = port();
        let next = successor(&base, &["sound.ini"]);
        initialize(&next, &user)?;
        assert_eq!(snapshot_policy(&user)?, Some(policy_sha256(&next)?));
        assert!(require_snapshot(&base, &user).is_err());
        Ok(())
    }

    #[test]
    fn adoption_refuses_a_non_file_runtime_object() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let runtime = directory.path().join("runtime");
        let user = directory.path().join("user");
        let base = port();
        let next = successor(&base, &["sound.ini"]);
        let target = directory.path().join("target");
        fs::create_dir_all(runtime.join("sound.ini"))?;
        assert!(adopt_added_paths(&base, &next, &runtime, &user, &target).is_err());
        assert!(!user.join("sound.ini").exists());
        assert!(!target.exists());
        // Unrelated policies adopt nothing.
        assert!(adopt_added_paths(&next, &base, &runtime, &user, &target)?.is_empty());
        Ok(())
    }

    #[test]
    fn appended_paths_are_ordinary_non_executable_files() -> Result<()> {
        let base = port();
        for name in [
            // Directories, or names that could become one, are not files.
            "presets",
            ".hidden",
            // Executable companions on the declared Windows platform.
            "override.dll",
            "launcher.exe",
            "setup.bat",
            "hook.ps1",
        ] {
            let next = successor(&base, &[name]);
            assert_eq!(added_paths(&base, &next)?, None, "{name}");
            assert!(additive_runs(&next).is_empty(), "{name}");
        }
        // A file within a new directory is still an ordinary file.
        let nested = successor(&base, &["presets/sound.ini"]);
        assert!(added_paths(&base, &nested)?.is_some());
        Ok(())
    }

    #[test]
    fn predecessor_framed_snapshots_leave_appended_files_uncovered() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let user = directory.path().join("user");
        let base = port();
        let next = successor(&base, &["sound.ini", "fixes.ini"]);
        initialize(&base, &user)?;
        assert_eq!(
            uncovered_added_paths(&next, &user)?,
            ["sound.ini", "fixes.ini"]
        );
        assert!(uncovered_added_paths(&base, &user)?.is_empty());
        let fresh = directory.path().join("fresh");
        initialize(&next, &fresh)?;
        assert!(uncovered_added_paths(&next, &fresh)?.is_empty());
        // A cheap count-based hash matches the full predecessor definition.
        let count = additive_runs(&next)[1];
        assert_eq!(predecessor_sha256(&next, count)?, policy_sha256(&base)?);
        Ok(())
    }

    #[test]
    fn partitioned_archive_data_rejects_aliases_links_and_wider_declarations() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let runtime = directory.path().join("runtime");
        let user = directory.path().join("user");
        fs::create_dir_all(&runtime)?;
        fs::write(runtime.join("Config.ini"), b"wrong spelling")?;
        let port = port();
        assert!(entries(&port, Some(&"a".repeat(64)), &runtime, &user).is_err());
        for shared in [
            vec![".."],
            vec!["saves", "saves/save.srm"],
            vec!["unowned"],
            vec![ROOT],
        ] {
            let mut changed = port.clone();
            changed
                .archive_data_compatibility_v1
                .as_mut()
                .unwrap()
                .shared_paths = shared.into_iter().map(String::from).collect();
            assert!(validate(&changed).is_err());
        }
        let mut external = port.clone();
        external.release.provider = crate::ReleaseSource::UserPrepared;
        assert!(validate(&external).is_err());
        #[cfg(unix)]
        {
            fs::remove_file(runtime.join("Config.ini"))?;
            std::os::unix::fs::symlink(directory.path(), runtime.join("saves"))?;
            assert!(entries(&port, Some(&"a".repeat(64)), &runtime, &user).is_err());
        }
        assert!(!user.exists());
        Ok(())
    }
}
