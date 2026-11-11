//! Installs reviewed mod packages into a profile and keeps the port's live data
//! equal to the selected profile.
//!
//! Storage (all under the port's canonical `user/<port>/`, so it travels with the
//! user tree but is never one of the declared persistent paths the launch sync
//! mirrors):
//!
//! ```text
//! .portcove-profiles/packages/<sha256>/<file>   content-addressed package bytes
//! .portcove-profiles/state/<profile-id>/<path>  parked player data of unselected profiles
//! .portcove-profiles/tmp/                       staging on the same filesystem
//! ```
//!
//! The *selected* profile's data lives in the live declared paths and the mods
//! root contains exactly its enabled packages. Launch synchronization is
//! unchanged: it mirrors the canonical live paths into the exact installed build.
//! Switching parks the departing profile's non-mod data and restores the arriving
//! one's, so saves and settings never cross profile boundaries and a disabled mod
//! is never restored into a build.
//!
//! Nothing here executes package content. Files the profile does not own (unknown
//! files in the mods root, or owned files whose bytes changed) are never
//! overwritten or deleted; they hold the operation and are reported.
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

use crate::{
    ModPackageHold, PortcoveError, PortcoveService, ProfileRevision, ProfileRevisionRequest,
    ResolvedPackage, Result, TypedOrdering, inspect_asset_archive, profile,
};

pub(crate) const STORE: &str = ".portcove-profiles";
const MODS: &str = "mods";
const OVERRIDE_DOMAIN: &str = "asset-override";

/// Reviewed per-game binding: which archive extensions a loader accepts in `mods`.
pub(crate) fn adapter_extensions(port_id: &str) -> Option<&'static [&'static str]> {
    match port_id {
        "shipwright" => Some(&["o2r", "otr"]),
        // The generic fixture port used by tests declares the same asset contract.
        #[cfg(test)]
        "starship" => Some(&["o2r", "otr"]),
        _ => None,
    }
}

pub(crate) struct Layout {
    /// The port's canonical live data root, `user/<port>`.
    user: PathBuf,
    /// Package and parked-profile storage at `user/.portcove-profiles/<port>`. It
    /// sits beside the port directories (so it travels with the `user` tree) but
    /// outside them, so per-port backups and restores never carry or replace it.
    store: PathBuf,
}

impl Layout {
    pub(crate) fn for_user(user: &Path) -> Self {
        let port = user
            .file_name()
            .map(|name| name.to_owned())
            .unwrap_or_default();
        let store = user
            .parent()
            .map(|root| root.join(STORE).join(&port))
            .unwrap_or_else(|| user.join(STORE));
        Self {
            user: user.into(),
            store,
        }
    }
    pub(crate) fn store(&self) -> PathBuf {
        self.store.clone()
    }
    pub(crate) fn package(&self, sha256: &str, file_name: &str) -> PathBuf {
        self.store().join("packages").join(sha256).join(file_name)
    }
    fn parked(&self, profile_id: &str) -> PathBuf {
        self.store().join("state").join(profile_id)
    }
    /// Reviewed provider packages waiting for consent, keyed by plan digest.
    pub(crate) fn staged(&self, plan_sha256: &str) -> PathBuf {
        self.store().join("staged").join(plan_sha256)
    }
    pub(crate) fn tmp(&self) -> PathBuf {
        self.store().join("tmp")
    }
    fn mods(&self) -> PathBuf {
        self.user.join(MODS)
    }
    fn journal(&self) -> PathBuf {
        self.store().join("switch.json")
    }
    fn pending(&self) -> PathBuf {
        self.store().join("restore-pending")
    }
}

/// True while the canonical live data is newer than the installed build's copy.
pub(crate) fn restore_pending(user: &Path) -> bool {
    Layout::for_user(user).pending().exists()
}

pub(crate) fn clear_restore_pending(user: &Path) -> Result<()> {
    match fs::remove_file(Layout::for_user(user).pending()) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.into()),
        _ => Ok(()),
    }
}

fn mark_restore_pending(layout: &Layout) -> Result<()> {
    fs::create_dir_all(layout.store())?;
    crate::durability::write_bytes_atomically(&layout.pending(), b"1", true)
}

/// A private, already-inspected copy ready to enter the package store.
pub(crate) struct StagedPackage {
    pub private: PathBuf,
    pub inspection: crate::ModPackageInspection,
    pub provider: Option<crate::ProviderPackageRef>,
}

/// What the live mods root holds relative to the revision that should own it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ModsObservation {
    /// Files whose names no enabled package of the owning revision provides.
    pub unmanaged: Vec<String>,
    /// Owned files whose bytes differ from the package that placed them.
    pub drifted: Vec<String>,
}

pub(crate) fn sha256_file(path: &Path) -> Result<String> {
    crate::service::sha256_file(path)
}

fn enabled(revision: &ProfileRevision) -> impl Iterator<Item = &ResolvedPackage> {
    revision.packages.iter().filter(|package| package.enabled)
}

/// Classifies live mods files against the revisions that may own them. A file is
/// owned when an enabled package of any listed revision has its name and bytes;
/// listing both the deployed and the newest revision lets an interrupted
/// deployment be completed without mistaking its own files for unknown ones.
fn observe(layout: &Layout, owners: &[&ProfileRevision]) -> Result<ModsObservation> {
    let mut observation = ModsObservation::default();
    let mods = layout.mods();
    if !mods.try_exists()? {
        return Ok(observation);
    }
    let mut expected: std::collections::BTreeMap<&str, BTreeSet<&str>> = Default::default();
    for owner in owners {
        for package in enabled(owner) {
            expected
                .entry(package.native_id.as_str())
                .or_default()
                .insert(package.sha256.as_str());
        }
    }
    for entry in fs::read_dir(&mods)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let metadata = fs::symlink_metadata(entry.path())?;
        match expected.get(name.as_str()) {
            Some(shas) if metadata.is_file() => {
                if !shas.contains(sha256_file(&entry.path())?.as_str()) {
                    observation.drifted.push(name);
                }
            }
            _ => observation.unmanaged.push(name),
        }
    }
    observation.unmanaged.sort();
    observation.drifted.sort();
    Ok(observation)
}

fn require_clean(observation: &ModsObservation, action: &str) -> Result<()> {
    if observation.unmanaged.is_empty() && observation.drifted.is_empty() {
        return Ok(());
    }
    Err(PortcoveError::conflict(format!(
        "the mods folder has files this profile does not own; {action} is held so they are not overwritten or deleted"
    ))
    .detail("unmanaged", observation.unmanaged.join(", "))
    .detail("changed_owned", observation.drifted.join(", ")))
}

fn stage_copy(layout: &Layout, source: &Path, destination: &Path) -> Result<()> {
    fs::create_dir_all(layout.tmp())?;
    let temporary = tempfile::NamedTempFile::new_in(layout.tmp())?;
    fs::copy(source, temporary.path())?;
    temporary.as_file().sync_all()?;
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)?;
    }
    temporary
        .persist(destination)
        .map_err(|error| PortcoveError::from(error.error))?;
    Ok(())
}

/// Brings the live mods root from `from` (what is deployed) to `to`. Both must
/// be observed clean first; only owned files change.
fn deploy(layout: &Layout, from: Option<&ProfileRevision>, to: &ProfileRevision) -> Result<()> {
    let wanted = enabled(to)
        .map(|package| (package.native_id.clone(), package.sha256.clone()))
        .collect::<std::collections::BTreeMap<_, _>>();
    // Verify every destination first so a missing or corrupt stored package fails
    // before any departing file is removed.
    let mut to_place = Vec::new();
    for package in enabled(to) {
        let live = live_package_path(layout, &package.native_id)?;
        if live.try_exists()? && sha256_file(&live)? == package.sha256 {
            continue;
        }
        let stored = layout.package(&package.sha256, &package.native_id);
        if !stored.try_exists()? || sha256_file(&stored)? != package.sha256 {
            return Err(PortcoveError::verification(
                "stored package bytes are missing or no longer match their recorded digest; nothing was changed",
            )
            .detail("package", &package.native_id));
        }
        to_place.push((stored, live));
    }
    if let Some(from) = from {
        for package in enabled(from) {
            if wanted.get(&package.native_id) != Some(&package.sha256) {
                let live = live_package_path(layout, &package.native_id)?;
                if live.try_exists()? {
                    fs::remove_file(live)?;
                }
            }
        }
    }
    for (stored, live) in to_place {
        stage_copy(layout, &stored, &live)?;
    }
    Ok(())
}

fn declared_state_paths(service: &PortcoveService, port_id: &str) -> Result<Vec<String>> {
    Ok(service
        .catalog()
        .port(port_id)?
        .persistent_paths
        .iter()
        .filter(|path| path.as_str() != MODS)
        .cloned()
        .collect())
}

fn live_package_path(layout: &Layout, native_id: &str) -> Result<PathBuf> {
    if !profile::valid_native_id(native_id) {
        return Err(PortcoveError::verification(
            "a package native ID is not a plain file name; nothing was changed",
        )
        .detail("package", native_id));
    }
    let path = layout.mods().join(native_id);
    if path.parent() != Some(layout.mods().as_path()) {
        return Err(PortcoveError::verification(
            "a package would leave the mods folder; nothing was changed",
        ));
    }
    Ok(path)
}

/// Moves each path that exists at `from` to `to`; idempotent so an interrupted
/// switch can run again. Refuses to merge into an existing destination.
fn move_paths(paths: &[String], from: &Path, to: &Path) -> Result<()> {
    for relative in paths {
        let source = from.join(relative);
        if !source.try_exists()? {
            continue;
        }
        crate::path::refuse_symlink_ancestors(&source)?;
        let destination = to.join(relative);
        if destination.try_exists()? {
            return Err(PortcoveError::conflict(
                "a profile's parked data already exists at the destination; nothing was merged",
            )
            .detail("path", destination.display().to_string()));
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::rename(&source, &destination)?;
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Start,
    Parked,
    Deployed,
}

impl Phase {
    fn name(self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::Parked => "parked",
            Self::Deployed => "deployed",
        }
    }
    fn parse(value: &str) -> Option<Self> {
        [Self::Start, Self::Parked, Self::Deployed]
            .into_iter()
            .find(|phase| phase.name() == value)
    }
}

fn write_journal(layout: &Layout, from: &str, to: &str, revision: u64, phase: Phase) -> Result<()> {
    let journal = serde_json::json!({
        "from": from, "to": to, "revision": revision, "phase": phase.name(),
    });
    crate::durability::write_bytes_atomically(
        &layout.journal(),
        journal.to_string().as_bytes(),
        true,
    )
}

impl PortcoveService {
    pub(crate) fn deploy_layout(&self, port_id: &str) -> Result<Layout> {
        if adapter_extensions(port_id).is_none() {
            return Err(PortcoveError::unsupported(
                "this port has no reviewed mod package contract yet",
            ));
        }
        let port = self.catalog().port(port_id)?;
        if !port.persistent_paths.iter().any(|path| path == MODS) {
            return Err(PortcoveError::unsupported(
                "this port does not declare a mods root",
            ));
        }
        Ok(Layout::for_user(&self.library.user_dir(port_id)))
    }

    /// Reviews and installs one local asset archive into a profile as a new
    /// revision. A live profile deploys immediately; otherwise the package waits
    /// in the store until the profile is selected.
    pub fn install_mod_package(
        &self,
        port_id: &str,
        profile_id: &str,
        source: &Path,
        expected_revision: u64,
    ) -> Result<ProfileRevision> {
        let layout = self.deploy_layout(port_id)?;
        let _guard = self.library.try_lock_port(port_id, "install-mod-package")?;
        self.recover_switch_locked(port_id, &layout)?;
        // Copy first, then inspect and store the private copy only, so the bytes that
        // were reviewed are the bytes that are kept.
        fs::create_dir_all(layout.tmp())?;
        let staging = tempfile::tempdir_in(layout.tmp())?;
        let file_name = source
            .file_name()
            .ok_or_else(|| PortcoveError::usage("the package path has no file name"))?;
        let private = staging.path().join(file_name);
        fs::copy(source, &private)?;
        let inspection = inspect_asset_archive(&private)?;
        self.install_staged_locked(
            port_id,
            profile_id,
            expected_revision,
            vec![StagedPackage {
                private,
                inspection,
                provider: None,
            }],
        )
    }

    /// Installs already-inspected private package copies as one new revision. The
    /// caller holds the port lock and has recovered any interrupted switch. Each
    /// copy is moved into the content-addressed store, so the reviewed bytes are the
    /// kept bytes.
    pub(crate) fn install_staged_locked(
        &self,
        port_id: &str,
        profile_id: &str,
        expected_revision: u64,
        staged: Vec<StagedPackage>,
    ) -> Result<ProfileRevision> {
        let layout = self.deploy_layout(port_id)?;
        let extensions = adapter_extensions(port_id).unwrap_or(&[]);
        if staged.is_empty() {
            return Err(PortcoveError::usage("there are no packages to install"));
        }
        for item in &staged {
            let inspection = &item.inspection;
            let extension = inspection
                .file_name
                .rsplit_once('.')
                .map(|(_, extension)| extension.to_ascii_lowercase());
            if !extension.is_some_and(|extension| extensions.contains(&extension.as_str())) {
                return Err(PortcoveError::unsupported(
                    "this game loads only the package types its reviewed contract lists",
                )
                .detail("accepted", extensions.join(", ")));
            }
            if let Some(hold) = inspection.holds.first() {
                return Err(match hold {
                    ModPackageHold::ContainsExecutableContent => PortcoveError::unsupported(
                        "the package contains executable files; asset-only support cannot install it",
                    )
                    .detail("entries", inspection.executable_entries.join(", ")),
                    ModPackageHold::Empty => PortcoveError::usage("the package contains no files"),
                });
            }
        }
        let connection = self.library.connection()?;
        let current = profile_current(&connection, port_id, profile_id)?;
        if current.revision != expected_revision {
            return Err(PortcoveError::conflict(
                "the profile changed after review; review its current revision again",
            ));
        }
        let selected = profile::selection(&connection, port_id)?;
        let live = selected.as_ref().is_some_and(|(id, _)| id == profile_id);
        if live {
            self.reconcile_selected(port_id, &layout, &connection, &current)?;
            require_clean(&observe(&layout, &[&current])?, "installing a package")?;
        }
        let mut packages = current.packages.clone();
        for item in staged {
            let inspection = &item.inspection;
            let stored = layout.package(&inspection.sha256, &inspection.file_name);
            if !stored.try_exists()? || sha256_file(&stored)? != inspection.sha256 {
                if let Some(parent) = stored.parent() {
                    fs::create_dir_all(parent)?;
                }
                if stored.try_exists()? {
                    fs::remove_file(&stored)?;
                }
                fs::rename(&item.private, &stored)?;
                if sha256_file(&stored)? != inspection.sha256 {
                    let _ = fs::remove_file(&stored);
                    return Err(PortcoveError::verification(
                        "package bytes changed while being stored; nothing was installed",
                    ));
                }
            }
            let package = ResolvedPackage {
                native_id: inspection.file_name.clone(),
                native_version: None,
                provider: item.provider.clone(),
                sha256: inspection.sha256.clone(),
                size: inspection.size,
                enabled: true,
                requires: Vec::new(),
            };
            packages.retain(|existing| existing.native_id != package.native_id);
            packages.push(package);
        }
        packages.sort_by(|a, b| a.native_id.cmp(&b.native_id));
        let orderings = with_override_order(&current.orderings, &packages);
        let request = ProfileRevisionRequest {
            expected_revision,
            packages: Some(packages),
            orderings: Some(orderings),
            ..Default::default()
        };
        self.advance_and_deploy(port_id, profile_id, &layout, &current, &request, live)
    }

    /// Enables or disables an installed package as a new revision.
    pub fn set_mod_package_enabled(
        &self,
        port_id: &str,
        profile_id: &str,
        native_id: &str,
        enabled_state: bool,
        expected_revision: u64,
    ) -> Result<ProfileRevision> {
        let layout = self.deploy_layout(port_id)?;
        let _guard = self.library.try_lock_port(port_id, "set-mod-enabled")?;
        self.recover_switch_locked(port_id, &layout)?;
        let connection = self.library.connection()?;
        let current = profile_current(&connection, port_id, profile_id)?;
        if current.revision != expected_revision {
            return Err(PortcoveError::conflict(
                "the profile changed after review; review its current revision again",
            ));
        }
        let mut packages = current.packages.clone();
        let package = packages
            .iter_mut()
            .find(|package| package.native_id == native_id)
            .ok_or_else(|| PortcoveError::not_found("the profile has no such package"))?;
        if package.enabled == enabled_state {
            return Ok(current);
        }
        package.enabled = enabled_state;
        let selected = profile::selection(&connection, port_id)?;
        let live = selected.as_ref().is_some_and(|(id, _)| id == profile_id);
        if live {
            self.reconcile_selected(port_id, &layout, &connection, &current)?;
            require_clean(&observe(&layout, &[&current])?, "changing a package")?;
        }
        let request = ProfileRevisionRequest {
            expected_revision,
            packages: Some(packages),
            ..Default::default()
        };
        self.advance_and_deploy(port_id, profile_id, &layout, &current, &request, live)
    }

    /// Makes a profile that already exists the owner of live data. Departing and
    /// arriving progress move whole; mods are reconciled from the exact revision.
    pub fn activate_profile(&self, port_id: &str, profile_id: &str) -> Result<ProfileRevision> {
        let layout = self.deploy_layout(port_id)?;
        let _guard = self.library.try_lock_port(port_id, "activate-profile")?;
        self.recover_switch_locked(port_id, &layout)?;
        let connection = self.library.connection()?;
        let target = profile_current(&connection, port_id, profile_id)?;
        let Some((current_id, current_revision)) = profile::selection(&connection, port_id)? else {
            return Err(PortcoveError::state(
                "the port has no selected profile; create its default profile first",
            ));
        };
        let departing = profile::revision_by_number(&connection, &current_id, current_revision)?;
        let latest = if current_id == profile_id {
            Some(&target)
        } else {
            None
        };
        let owners = [Some(&departing), latest]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        require_clean(&observe(&layout, &owners)?, "switching profiles")?;
        if current_id == profile_id {
            if current_revision == target.revision {
                return Ok(target);
            }
            self.reconcile_selected(port_id, &layout, &connection, &target)?;
            return Ok(target);
        }
        // Bring live data up to date from the launched build before parking it.
        self.collect_active_user_data_if_launched(port_id)?;
        let paths = declared_state_paths(self, port_id)?;
        fs::create_dir_all(layout.store())?;
        write_journal(
            &layout,
            &current_id,
            profile_id,
            target.revision,
            Phase::Start,
        )?;
        self.switch_steps(
            port_id,
            &layout,
            &current_id,
            profile_id,
            &paths,
            &departing,
            &target,
            Phase::Start,
        )?;
        Ok(target)
    }

    /// If a same-profile deployment was interrupted, finish it: the selection
    /// still names an older revision than the profile's current one.
    fn reconcile_selected(
        &self,
        port_id: &str,
        layout: &Layout,
        connection: &rusqlite::Connection,
        current: &ProfileRevision,
    ) -> Result<()> {
        let Some((id, revision)) = profile::selection(connection, port_id)? else {
            return Ok(());
        };
        if id != current.profile_id || revision == current.revision {
            return Ok(());
        }
        let materialized = profile::revision_by_number(connection, &id, revision)?;
        require_clean(
            &observe(layout, &[&materialized, current])?,
            "finishing an interrupted change",
        )?;
        mark_restore_pending(layout)?;
        deploy(layout, Some(&materialized), current)?;
        profile::set_selection(connection, port_id, &id, current.revision)?;
        self.sync_build_after_change(port_id, layout);
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn switch_steps(
        &self,
        port_id: &str,
        layout: &Layout,
        from: &str,
        to: &str,
        paths: &[String],
        departing: &ProfileRevision,
        target: &ProfileRevision,
        mut phase: Phase,
    ) -> Result<()> {
        mark_restore_pending(layout)?;
        if phase == Phase::Start {
            move_paths(paths, &layout.user, &layout.parked(from))?;
            phase = Phase::Parked;
            write_journal(layout, from, to, target.revision, phase)?;
        }
        if phase == Phase::Parked {
            deploy(layout, Some(departing), target)?;
            phase = Phase::Deployed;
            write_journal(layout, from, to, target.revision, phase)?;
        }
        if phase == Phase::Deployed {
            move_paths(paths, &layout.parked(to), &layout.user)?;
        }
        let connection = self.library.connection()?;
        profile::set_selection(&connection, port_id, to, target.revision)?;
        fs::remove_file(layout.journal())?;
        self.sync_build_after_change(port_id, layout);
        Ok(())
    }

    /// Finishes a switch interrupted after its journal was written. The journal
    /// records the last completed phase, and each phase is skipped once done, so a
    /// resumed switch never re-parks data that has already arrived.
    pub(crate) fn recover_switch_locked(&self, port_id: &str, layout: &Layout) -> Result<()> {
        let journal = layout.journal();
        if !journal.try_exists()? {
            return Ok(());
        }
        let value: serde_json::Value = serde_json::from_slice(&fs::read(&journal)?)?;
        let field = |name: &str| value[name].as_str().map(str::to_owned);
        let (Some(from), Some(to), Some(revision), Some(phase)) = (
            field("from"),
            field("to"),
            value["revision"].as_u64(),
            field("phase").and_then(|phase| Phase::parse(&phase)),
        ) else {
            return Err(PortcoveError::state("profile switch journal is unreadable"));
        };
        let connection = self.library.connection()?;
        let (selected, selected_revision) = profile::selection(&connection, port_id)?
            .ok_or_else(|| PortcoveError::state("profile switch has no selection"))?;
        if selected == to && selected_revision == revision {
            fs::remove_file(journal)?;
            return Ok(());
        }
        let departing = profile::revision_by_number(&connection, &selected, selected_revision)?;
        let target = profile::revision_by_number(&connection, &to, revision)?;
        require_clean(
            &observe(layout, &[&departing, &target])?,
            "resuming an interrupted profile switch",
        )?;
        let paths = declared_state_paths(self, port_id)?;
        self.switch_steps(
            port_id, layout, &from, &to, &paths, &departing, &target, phase,
        )
    }

    fn advance_and_deploy(
        &self,
        port_id: &str,
        profile_id: &str,
        layout: &Layout,
        current: &ProfileRevision,
        request: &ProfileRevisionRequest,
        live: bool,
    ) -> Result<ProfileRevision> {
        let next = self.create_profile_revision_locked(port_id, profile_id, request)?;
        if live {
            mark_restore_pending(layout)?;
            deploy(layout, Some(current), &next)?;
            let connection = self.library.connection()?;
            profile::set_selection(&connection, port_id, profile_id, next.revision)?;
            self.sync_build_after_change(port_id, layout);
        }
        Ok(next)
    }

    /// Refreshes the active build from canonical data and clears the pending mark
    /// only when that succeeded. Otherwise the mark keeps collection from copying
    /// the stale build over the profile until launch restores it.
    fn sync_build_after_change(&self, port_id: &str, layout: &Layout) {
        if self.restore_active_user_data_if_launched(port_id) {
            let _ = clear_restore_pending(&layout.user);
        }
    }

    /// Read-only view of live mods against the selected revision.
    pub fn observe_live_mods(&self, port_id: &str) -> Result<LiveMods> {
        let layout = self.deploy_layout(port_id)?;
        let connection = self.library.connection()?;
        let Some((id, revision)) = profile::selection(&connection, port_id)? else {
            return Ok(LiveMods::default());
        };
        let owner = profile::revision_by_number(&connection, &id, revision)?;
        let observation = observe(&layout, &[&owner])?;
        Ok(LiveMods {
            profile_id: Some(id),
            revision: Some(revision),
            unmanaged: observation.unmanaged,
            changed_owned: observation.drifted,
        })
    }
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
pub struct LiveMods {
    pub profile_id: Option<String>,
    pub revision: Option<u64>,
    /// Files in the mods folder this profile did not install; never touched.
    pub unmanaged: Vec<String>,
    /// Installed files whose bytes changed outside Portcove; never overwritten.
    pub changed_owned: Vec<String>,
}

fn profile_current(
    connection: &rusqlite::Connection,
    port_id: &str,
    profile_id: &str,
) -> Result<ProfileRevision> {
    profile::current_revision(connection, port_id, profile_id)
}

/// Appends new packages to the single asset-override domain, keeping prior order.
fn with_override_order(
    existing: &[TypedOrdering],
    packages: &[ResolvedPackage],
) -> Vec<TypedOrdering> {
    let present = packages
        .iter()
        .map(|package| package.native_id.as_str())
        .collect::<BTreeSet<_>>();
    let mut order = existing
        .iter()
        .find(|ordering| ordering.domain == OVERRIDE_DOMAIN)
        .map(|ordering| ordering.native_ids.clone())
        .unwrap_or_default();
    order.retain(|id| present.contains(id.as_str()));
    for package in packages {
        if !order.contains(&package.native_id) {
            order.push(package.native_id.clone());
        }
    }
    let mut orderings = existing
        .iter()
        .filter(|ordering| ordering.domain != OVERRIDE_DOMAIN)
        .cloned()
        .collect::<Vec<_>>();
    orderings.push(TypedOrdering {
        domain: OVERRIDE_DOMAIN.into(),
        native_ids: order,
    });
    orderings
}

#[cfg(test)]
#[path = "profile_deploy_tests.rs"]
mod tests;
