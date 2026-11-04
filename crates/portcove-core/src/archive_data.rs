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
    let Some(policy) = &port.archive_data_compatibility_v1 else {
        return Ok(());
    };
    if !crate::persistence::ready_staged_archive(port)
        || port.release.provider != crate::ReleaseSource::Github
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
    crate::managed_runtime_policy::validate_release_rules(port)?;
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

pub(crate) fn namespace(port: &PortDefinition, user_root: &Path) -> Result<PathBuf> {
    Ok(user_root.join(ROOT).join(policy_sha256(port)?))
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
    let expected = policy_sha256(port)?;
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
        if count > 0 || entry.file_name() != expected.as_str() || !entry.file_type()?.is_dir() {
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
    validate(port)?;
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
