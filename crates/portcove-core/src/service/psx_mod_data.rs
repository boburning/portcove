//! Preserve complete framework mod packages beside successor defaults.
//!
//! This does not classify package origin, authenticate mods, or interpret/rebase
//! upstream state. The retained adapter owns the declared `mods` tree; upstream
//! still decides whether a selected package is compatible with a runtime.
//! The bounded data-restoration receipt and conservative uninitialized-tree
//! collection also serve ready staged archives and opted-in N64 runtimes. Its historical metadata filename
//! stays readable; it grants neither executable nor mod authenticity.
use super::*;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, PartialEq, Eq)]
enum Entry {
    Directory,
    File {
        bytes: u64,
        sha256: String,
        modified: String,
    },
}

// A mod package's content identity does not include archive timestamps.
fn same_contents(left: &Entry, right: &Entry) -> bool {
    match (left, right) {
        (Entry::Directory, Entry::Directory) => true,
        (
            Entry::File {
                bytes: a,
                sha256: b,
                ..
            },
            Entry::File {
                bytes: c,
                sha256: d,
                ..
            },
        ) => a == c && b == d,
        _ => false,
    }
}

type Tree = BTreeMap<PathBuf, Entry>;

fn entry_path(root: &Path, relative: &Path) -> PathBuf {
    if relative.as_os_str().is_empty() {
        root.to_path_buf()
    } else {
        root.join(relative)
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DataRestored {
    schema_version: u32,
    port_id: String,
    install_id: String,
    manifest_sha256: String,
}

/// Completion of a Core data restore, never launch, source or mod qualification.
pub(super) fn initialized(install: &InstallRecord) -> Result<bool> {
    let path = install.path.join(PSX_DATA_RECEIPT);
    if !path.try_exists()? {
        refuse_symlink_ancestors(&path)?;
        return Ok(false);
    }
    let mut bytes = Vec::new();
    crate::external_runtime::open_single_link_file(&path)?
        .take(4097)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 4096 {
        return Err(conflict(
            &path,
            &path,
            "the Core data-restore receipt exceeds its limit",
        ));
    }
    let receipt: DataRestored = serde_json::from_slice(&bytes)
        .map_err(|_| conflict(&path, &path, "the Core data-restore receipt is invalid"))?;
    if receipt.schema_version != 1 {
        return Err(PortcoveError::unsupported("PS1 data-restore receipt needs a compatible Portcove version; preserve it before retrying").detail("path", path.display().to_string()));
    }
    Ok(receipt.port_id == install.port_id
        && receipt.install_id == install.id
        && receipt.manifest_sha256 == install.manifest_sha256)
}

pub(crate) fn metadata_name(relative: &str) -> bool {
    relative == PSX_DATA_RECEIPT
        || relative
            .strip_prefix(PSX_DATA_WRITE_PREFIX)
            .is_some_and(|tail| tail.len() == 8 && tail.bytes().all(|b| b.is_ascii_alphanumeric()))
}

fn record_initialized(install: &InstallRecord) -> Result<()> {
    if initialized(install)? {
        return Ok(());
    }
    let path = install.path.join(PSX_DATA_RECEIPT);
    refuse_symlink_ancestors(&path)?;
    crate::durability::write_bytes_atomically_with_prefix(
        &path,
        &serde_json::to_vec(&DataRestored {
            schema_version: 1,
            port_id: install.port_id.clone(),
            install_id: install.id.clone(),
            manifest_sha256: install.manifest_sha256.clone(),
        })?,
        true,
        Some(PSX_DATA_WRITE_PREFIX),
    )
}

struct AdditiveTree {
    source: PathBuf,
    destination: PathBuf,
    from: Tree,
    to: Tree,
}

impl AdditiveTree {
    fn prepare(source: &Path, destination: &Path, exact_metadata: bool) -> Result<Self> {
        let from = snapshot(source, &|| Ok(()))?;
        let to = snapshot(destination, &|| Ok(()))?;
        let mut names = BTreeMap::new();
        for path in from.keys().chain(to.keys()) {
            if let Some(previous) = names.insert(
                crate::path::unicode(path, "player-data path")?.to_lowercase(),
                path,
            ) && previous != path
            {
                return Err(conflict(
                    &entry_path(source, previous),
                    &entry_path(destination, path),
                    "unlaunched player-data paths differ in case",
                ));
            }
            if let (Some(left), Some(right)) = (from.get(path), to.get(path))
                && if exact_metadata {
                    left != right
                } else {
                    !same_contents(left, right)
                }
            {
                return Err(conflict(
                    &entry_path(source, path),
                    &entry_path(destination, path),
                    "unlaunched runtime data differs from saved canonical data; preserve both copies and choose the intended data before retrying",
                ));
            }
        }
        Ok(Self {
            source: source.into(),
            destination: destination.into(),
            from,
            to,
        })
    }

    fn apply(&self, excluded: Option<&Path>) -> Result<()> {
        if snapshot(&self.source, &|| Ok(()))? != self.from
            || snapshot(&self.destination, &|| Ok(()))? != self.to
        {
            return Err(conflict(
                &self.source,
                &self.destination,
                "unlaunched player data changed after preflight",
            ));
        }
        self.copy_missing(excluded)
    }

    fn copy_missing(&self, excluded: Option<&Path>) -> Result<()> {
        for (relative, entry) in &self.from {
            if self.to.contains_key(relative)
                || excluded.is_some_and(|prefix| relative.starts_with(prefix))
            {
                continue;
            }
            let destination = entry_path(&self.destination, relative);
            refuse_symlink_ancestors(&destination)?;
            match entry {
                Entry::Directory => fs::create_dir_all(&destination)?,
                Entry::File { .. } => {
                    fs::create_dir_all(destination.parent().unwrap())?;
                    refuse_symlink_ancestors(&destination)?;
                    let mut temporary =
                        tempfile::NamedTempFile::new_in(destination.parent().unwrap())?;
                    if fingerprint(
                        &entry_path(&self.source, relative),
                        Some(temporary.as_file_mut()),
                        &|| Ok(()),
                    )? != *entry
                    {
                        return Err(conflict(
                            &entry_path(&self.source, relative),
                            &destination,
                            "player data changed while copying",
                        ));
                    }
                    temporary
                        .persist_noclobber(&destination)
                        .map_err(|error| PortcoveError::from(error.error))?;
                    crate::durability::sync_publication(destination.parent().unwrap())?;
                }
            }
        }
        Ok(())
    }
}

pub(super) fn owns_mods(port: &PortDefinition) -> bool {
    (port.adapter == AdapterKind::PsxRecompManaged
        || port.mod_package_policy == Some(crate::ModPackagePolicy::VersionedPackagesV1))
        && port.persistent_paths.iter().any(|path| path == "mods")
}

fn conflict(source: &Path, destination: &Path, reason: &str) -> PortcoveError {
    PortcoveError::conflict(format!(
        "Mod packages need review: {reason}. Preserve the reported copies separately, resolve the conflict, then retry. Existing files have not been overwritten; complete additional packages may already be present. Upstream decides mod/save compatibility."
    ))
    .detail("source_path", source.display().to_string())
    .detail("destination_path", destination.display().to_string())
}

fn snapshot(root: &Path, checkpoint: &dyn Fn() -> Result<()>) -> Result<Tree> {
    crate::runtime_data_policy::refuse_sensitive_tree(root)?;
    let mut entries = Tree::new();
    let mut pending = vec![PathBuf::new()];
    let mut names = BTreeSet::new();
    while let Some(relative) = pending.pop() {
        checkpoint()?;
        if entries.len() >= 65_536 || relative.components().count() > 64 {
            return Err(conflict(
                root,
                root,
                "the bounded mod-tree review limit was reached",
            ));
        }
        let path = entry_path(root, &relative);
        refuse_symlink_ancestors(&path)?;
        let metadata = match fs::symlink_metadata(&path) {
            Err(error)
                if relative.as_os_str().is_empty()
                    && error.kind() == std::io::ErrorKind::NotFound =>
            {
                continue;
            }
            result => result?,
        };
        if metadata.file_type().is_symlink() {
            return Err(conflict(&path, &path, "a link is present"));
        }
        let name = crate::path::unicode(&relative, "mod path")?.to_lowercase();
        if !names.insert(name) {
            return Err(conflict(&path, &path, "case-colliding paths are present"));
        }
        let entry = if metadata.is_dir() {
            for child in fs::read_dir(&path)? {
                pending.push(relative.join(child?.file_name()));
                if pending.len() + entries.len() > 65_536 {
                    return Err(conflict(
                        root,
                        root,
                        "the bounded mod-tree review limit was reached",
                    ));
                }
            }
            Entry::Directory
        } else if metadata.is_file() {
            fingerprint(&path, None, checkpoint)?
        } else {
            return Err(conflict(&path, &path, "a nonregular entry is present"));
        };
        entries.insert(relative, entry);
    }
    Ok(entries)
}

fn fingerprint(
    path: &Path,
    mut output: Option<&mut fs::File>,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<Entry> {
    use std::io::Write;
    let mut input = crate::external_runtime::open_single_link_file(path)?;
    let before = input.metadata()?;
    let mut digest = Sha256::new();
    let mut bytes = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        checkpoint()?;
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        bytes += count as u64;
        if bytes > before.len() {
            return Err(conflict(path, path, "a file grew during review"));
        }
        digest.update(&buffer[..count]);
        if let Some(output) = output.as_mut() {
            output.write_all(&buffer[..count])?;
        }
    }
    let after = input.metadata()?;
    if bytes != before.len()
        || after.len() != before.len()
        || after.modified()? != before.modified()?
    {
        return Err(conflict(path, path, "a file changed during review"));
    }
    if let Some(output) = output {
        crate::runtime_data_policy::preserve_modified_time(output, &before)?;
        output.sync_all()?;
    }
    Ok(Entry::File {
        bytes,
        sha256: hex::encode(digest.finalize()),
        modified: crate::runtime_data_policy::modified_stamp(&before)?,
    })
}

fn packages(tree: &Tree, root: &Path) -> Result<BTreeSet<PathBuf>> {
    let mut result = BTreeSet::new();
    for (relative, entry) in tree {
        if !relative.starts_with("packages") {
            continue;
        }
        let depth = relative.components().count();
        if depth <= 3 && *entry != Entry::Directory {
            return Err(conflict(
                &root.join(relative),
                &root.join(relative),
                "a package ID/version is not a directory",
            ));
        }
        if depth == 3 {
            result.insert(relative.clone());
        }
    }
    Ok(result)
}

pub(super) struct ModRestore {
    source: PathBuf,
    destination: PathBuf,
    source_tree: Tree,
    destination_tree: Tree,
    additions: Vec<PathBuf>,
}

impl ModRestore {
    /// Complete preflight precedes any player-data restore or package publication.
    pub(super) fn prepare(source: &Path, destination: &Path) -> Result<Self> {
        Self::prepare_checked(source, destination, &|| Ok(()))
    }

    fn prepare_checked(
        source: &Path,
        destination: &Path,
        checkpoint: &dyn Fn() -> Result<()>,
    ) -> Result<Self> {
        let source_tree = snapshot(source, checkpoint)?;
        let destination_tree = snapshot(destination, checkpoint)?;
        for (tree, root) in [(&source_tree, source), (&destination_tree, destination)] {
            if tree
                .get(Path::new(""))
                .is_some_and(|entry| *entry != Entry::Directory)
            {
                return Err(conflict(
                    root,
                    root,
                    "the declared mods root is not a directory",
                ));
            }
        }
        let mut names = BTreeMap::new();
        for (relative, entry) in source_tree.iter().chain(&destination_tree) {
            let key = crate::path::unicode(relative, "mod path")?.to_lowercase();
            if let Some(prior) = names.insert(key, relative)
                && prior != relative
            {
                return Err(conflict(
                    &source.join(prior),
                    &destination.join(relative),
                    "paths disagree in case",
                ));
            }
            if let Some(other) = destination_tree.get(relative)
                && matches!(entry, Entry::Directory) != matches!(other, Entry::Directory)
            {
                return Err(conflict(
                    &source.join(relative),
                    &destination.join(relative),
                    "file/directory types differ",
                ));
            }
        }
        let from = packages(&source_tree, source)?;
        let to = packages(&destination_tree, destination)?;
        for package in from.intersection(&to) {
            let left: Tree = source_tree
                .range(package.clone()..)
                .take_while(|(path, _)| path.starts_with(package))
                .map(|(p, e)| (p.clone(), e.clone()))
                .collect();
            let right: Tree = destination_tree
                .range(package.clone()..)
                .take_while(|(path, _)| path.starts_with(package))
                .map(|(p, e)| (p.clone(), e.clone()))
                .collect();
            if left.len() != right.len()
                || left.iter().any(|(path, entry)| {
                    right
                        .get(path)
                        .is_none_or(|other| !same_contents(entry, other))
                })
            {
                let path = left
                    .keys()
                    .chain(right.keys())
                    .find(|p| match (left.get(*p), right.get(*p)) {
                        (Some(a), Some(b)) => !same_contents(a, b),
                        _ => true,
                    })
                    .unwrap();
                return Err(conflict(
                    &source.join(path),
                    &destination.join(path),
                    "the same package ID/version has different contents",
                ));
            }
        }
        Ok(Self {
            source: source.into(),
            destination: destination.into(),
            source_tree,
            destination_tree,
            additions: from.difference(&to).cloned().collect(),
        })
    }

    pub(super) fn apply(self, library: &Library, port_id: &str, install_root: &Path) -> Result<()> {
        self.apply_mode(
            library,
            port_id,
            install_root
                .parent()
                .ok_or_else(|| PortcoveError::state("installation has no output root"))?,
            false,
        )
    }

    fn apply_mode(
        self,
        library: &Library,
        port_id: &str,
        output: &Path,
        preserve_canonical: bool,
    ) -> Result<()> {
        let operation_id = Uuid::new_v4().to_string();
        let staging = if self.additions.is_empty() {
            None
        } else {
            let bytes = self
                .additions
                .iter()
                .flat_map(|package| {
                    self.source_tree
                        .range(package.clone()..)
                        .take_while(move |(path, _)| path.starts_with(package))
                })
                .try_fold(0_u64, |total, (_, entry)| {
                    total
                        .checked_add(match entry {
                            Entry::Directory => 0,
                            Entry::File { bytes, .. } => *bytes,
                        })
                        .ok_or_else(|| PortcoveError::unsupported("mod package copy size overflow"))
                })?;
            let prepared = crate::output_root::prepare_for_install(
                library,
                port_id,
                output,
                &operation_id,
                bytes,
            )?;
            fs::create_dir_all(prepared.operation_root.parent().unwrap())?;
            crate::output_root::validate_staging_path(
                library,
                port_id,
                &operation_id,
                &prepared.operation_root,
            )?;
            fs::create_dir(&prepared.operation_root)?;
            Some(prepared.operation_root)
        };
        let result = self.apply_checked_mode(staging.as_deref(), &|| Ok(()), preserve_canonical).map_err(|mut error| {
            error.message.push_str(" Original source packages and pre-existing destination packages are preserved; complete additional packages may already be present. Retry after resolving the reported conflict.");
            error
        });
        match (result, staging) {
            (Err(error), Some(staging)) => {
                Err(error.detail("preserved_staging_path", staging.display().to_string()))
            }
            (Ok(()), Some(staging)) => {
                crate::output_root::validate_staging_path(
                    library,
                    port_id,
                    &operation_id,
                    &staging,
                )?;
                fs::remove_dir_all(&staging)?;
                Ok(())
            }
            (result, None) => result,
        }
    }

    #[cfg(test)]
    fn apply_checked(
        &self,
        staging: Option<&Path>,
        checkpoint: &dyn Fn() -> Result<()>,
    ) -> Result<()> {
        self.apply_checked_mode(staging, checkpoint, false)
    }

    fn apply_checked_mode(
        &self,
        staging: Option<&Path>,
        checkpoint: &dyn Fn() -> Result<()>,
        preserve_canonical: bool,
    ) -> Result<()> {
        // Materialize every complete absent package privately before publication.
        for package in &self.additions {
            let staging = staging
                .ok_or_else(|| PortcoveError::state("mod preservation has no private staging"))?;
            for (relative, entry) in self
                .source_tree
                .range(package.clone()..)
                .take_while(|(path, _)| path.starts_with(package))
            {
                checkpoint()?;
                let path = staging.join(relative);
                match entry {
                    Entry::Directory => fs::create_dir_all(&path)?,
                    Entry::File { .. } => {
                        let mut output = fs::OpenOptions::new()
                            .write(true)
                            .create_new(true)
                            .open(&path)?;
                        if fingerprint(&self.source.join(relative), Some(&mut output), checkpoint)?
                            != *entry
                        {
                            return Err(conflict(
                                &self.source.join(relative),
                                &path,
                                "a package changed while copying",
                            ));
                        }
                    }
                }
            }
        }
        self.require_unchanged(checkpoint)?;
        for package in &self.additions {
            checkpoint()?;
            let destination = self.destination.join(package);
            refuse_symlink_ancestors(&destination)?;
            fs::create_dir_all(destination.parent().unwrap())?;
            refuse_symlink_ancestors(&destination)?;
            crate::durability::rename_noreplace(&staging.unwrap().join(package), &destination)?;
            crate::durability::sync_publication(destination.parent().unwrap())?;
        }
        if preserve_canonical {
            return AdditiveTree::prepare(&self.source, &self.destination, false)?
                .apply(Some(Path::new("packages")));
        }
        // Keep deliberate upstream state and its normal deletion semantics. Never
        // recursively mirror packages: destination-only complete versions survive.
        for (relative, _) in self
            .source_tree
            .iter()
            .filter(|(path, _)| path.components().count() == 1 && *path != Path::new("packages"))
        {
            checkpoint()?;
            super::sync_entry(
                &self.source.join(relative),
                &self.destination.join(relative),
            )?;
        }
        for (relative, _) in self
            .destination_tree
            .iter()
            .filter(|(path, _)| path.components().count() == 1 && *path != Path::new("packages"))
        {
            if !self.source_tree.contains_key(relative) {
                checkpoint()?;
                super::remove_managed_entry(&self.destination.join(relative))?;
            }
        }
        Ok(())
    }

    pub(super) fn require_unchanged(&self, checkpoint: &dyn Fn() -> Result<()>) -> Result<()> {
        if snapshot(&self.source, checkpoint)? != self.source_tree
            || snapshot(&self.destination, checkpoint)? != self.destination_tree
        {
            return Err(conflict(
                &self.source,
                &self.destination,
                "mod paths changed after preflight",
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;

impl PortcoveService {
    fn psx_data_install(
        &self,
        port: &PortDefinition,
        install_root: &Path,
    ) -> Result<Option<InstallRecord>> {
        if !crate::persistence::requires_restore_receipt(port) {
            return Ok(None);
        }
        let root = self.managed_install_root(&port.id, install_root)?;
        for install in self.library.all_installs()? {
            if install.port_id != port.id {
                continue;
            }
            match fs::canonicalize(&install.path) {
                Ok(path) if path == root => return Ok(Some(install)),
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                    return Err(error.into());
                }
                _ => {}
            }
        }
        Err(PortcoveError::verification(
            "Player-data restore needs its registered installation identity",
        ))
    }

    pub(super) fn require_psx_data_receipt_readable(
        &self,
        port: &PortDefinition,
        install_root: &Path,
    ) -> Result<()> {
        if let Some(install) = self.psx_data_install(port, install_root)? {
            initialized(&install)?;
        }
        Ok(())
    }

    pub(super) fn record_psx_data_restored(
        &self,
        port: &PortDefinition,
        install_root: &Path,
    ) -> Result<()> {
        if let Some(install) = self.psx_data_install(port, install_root)? {
            record_initialized(&install)?;
        }
        Ok(())
    }

    pub(super) fn collect_uninitialized_psx_data(
        &self,
        port: &PortDefinition,
        install_root: &Path,
        persistent_root: &Path,
        user_root: &Path,
    ) -> Result<Option<Vec<PathBuf>>> {
        let Some(install) = self.psx_data_install(port, install_root)? else {
            return Ok(None);
        };
        if initialized(&install)? {
            return Ok(None);
        }
        let mut plans = Vec::new();
        let mut mods = None;
        for relative in crate::persistence::entries(port, &[persistent_root, user_root])? {
            let from = persistent_root.join(&relative);
            let to = user_root.join(&relative);
            // Package identity compares complete content, not publisher timestamps.
            // Keep the additive preflight for conflicting unproven root state.
            let plan = AdditiveTree::prepare(
                &from,
                &to,
                (crate::persistence::ready_staged_archive(port)
                    || port.n64_runtime_at_executable_parent)
                    && !(relative == "mods" && owns_mods(port)),
            )?;
            if relative == "mods" && owns_mods(port) {
                mods = Some(ModRestore::prepare(&from, &to)?);
            }
            plans.push((relative, plan));
        }
        let mut copied = Vec::new();
        for (relative, plan) in plans {
            if relative == "mods" && owns_mods(port) {
                if let Some(mods) = mods.take() {
                    mods.apply_mode(
                        &self.library,
                        &port.id,
                        &self.library.versions_dir().join(&port.id),
                        true,
                    )?;
                }
            } else {
                plan.apply(None)?;
            }
            if plan.destination.try_exists()? {
                copied.push(plan.destination);
            }
        }
        Ok(Some(copied))
    }

    /// Preflight every retained runtime before an explicit data restore publishes
    /// its canonical snapshot or synchronizes any other runtime's player data.
    pub(super) fn preflight_psx_mod_restores(
        &self,
        port_id: &str,
        user_root: &Path,
    ) -> Result<BTreeMap<PathBuf, ModRestore>> {
        let mut plans = BTreeMap::new();
        for (install_root, contract) in self.retained_persistence_contracts(port_id)? {
            if !contract.writes_directly
                && (contract.port.adapter == AdapterKind::PsxRecompManaged
                    || contract.port.mod_package_policy.is_some())
            {
                self.require_psx_data_receipt_readable(&contract.port, &install_root)?;
                if !owns_mods(&contract.port) {
                    continue;
                }
                let persistent_root = self.persistence_root(&contract.port, &install_root)?;
                plans.insert(
                    install_root,
                    ModRestore::prepare(&user_root.join("mods"), &persistent_root.join("mods"))?,
                );
            }
        }
        Ok(plans)
    }

    pub(crate) fn require_psx_restore_preflight(
        &self,
        port_id: &str,
        user_root: &Path,
    ) -> Result<()> {
        self.preflight_psx_mod_restores(port_id, user_root)?;
        Ok(())
    }

    /// Shared preflight before the caller's reuse, activation or recovery commit.
    pub(crate) fn prepare_retained_install_data(&self, install: &InstallRecord) -> Result<()> {
        self.require_portable_runtime_unchanged(install)?;
        let qualification = self.installed_mutability_qualification(install)?;
        let active = self
            .library
            .status(&install.port_id, install.channel)?
            .active;
        if let Some(active) = &active {
            self.require_portable_target_transition(active, install)?;
        }
        self.collect_active_user_data_if_launched(&install.port_id)?;
        if let Some(active) = &active {
            self.require_portable_target_transition(active, install)?;
        }
        self.restore_retained_user_data_to(install)?;
        if let Some(active) = &active {
            self.require_portable_target_transition(active, install)?;
        }
        Installer::new(self.library.clone())?.verify_critical(install, &qualification)?;
        Ok(())
    }
}
