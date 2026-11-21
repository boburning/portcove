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
    io::Write,
    path::{Path, PathBuf},
};

use crate::{
    ModPackageHold, PortcoveError, PortcoveService, ProfileRevision, ProfileRevisionRequest,
    ResolvedPackage, Result, TypedOrdering, inspect_asset_archive,
    native_mod_list::{self, LoaderList, NativeList},
    profile,
    profile_package_files::{profile_package_files, require_managed_custody},
};

pub(crate) const STORE: &str = ".portcove-profiles";
const MODS: &str = "mods";
const OVERRIDE_DOMAIN: &str = "asset-override";

/// Reviewed per-game binding: which archive extensions a loader accepts in `mods`.
#[path = "profile_recovery.rs"]
mod recovery;
pub use recovery::{ProfileRecoveryPlan, ProfileRecoveryProgress};

pub(crate) struct Layout {
    /// The port's canonical live data root, `user/<port>`.
    user: PathBuf,
    /// Package and parked-profile storage at `user/.portcove-profiles/<port>`. It
    /// sits beside the port directories (so it travels with the `user` tree) but
    /// outside them, so per-port backups and restores never carry or replace it.
    store: PathBuf,
    loader: Option<crate::profile_loader::ReviewedLoader>,
}

impl Layout {
    pub(crate) fn port_id(&self) -> String {
        self.user
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default()
    }
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
            loader: None,
        }
    }
    pub(crate) fn with_loader(mut self, loader: crate::profile_loader::ReviewedLoader) -> Self {
        self.loader = Some(loader);
        self
    }
    pub(crate) fn loader_list(&self) -> Option<LoaderList<'_>> {
        self.loader.as_ref().map(native_mod_list::loader_list)
    }
    pub(crate) fn recomp_game(&self) -> Option<&str> {
        self.loader.as_ref()?.native_game.as_deref()
    }
    pub(crate) fn recomp_builtins(&self) -> &'static [&'static str] {
        self.loader
            .as_ref()
            .map(crate::profile_loader::ReviewedLoader::recomp_builtins)
            .unwrap_or_default()
    }
    pub(crate) fn package_extensions(&self) -> &'static [&'static str] {
        self.loader
            .as_ref()
            .map(|loader| loader.engine.package_extensions())
            .unwrap_or_default()
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
    pub(crate) fn mods(&self) -> PathBuf {
        self.user.join(MODS)
    }
    pub(crate) fn journal(&self) -> PathBuf {
        self.store().join("switch.json")
    }
    /// Package digests whose code the player explicitly allowed to run.
    pub(crate) fn code_consent(&self) -> PathBuf {
        self.store().join("code-consent.json")
    }
    fn pending(&self) -> PathBuf {
        self.store().join("restore-pending")
    }
}

/// Clone only progress covered by the reviewed save contract. The parked
/// destination belongs to the unpublished new profile, so no live path moves.
pub(crate) fn copy_supported_progress(
    service: &PortcoveService,
    connection: &rusqlite::Connection,
    source: &crate::Profile,
    revision: &ProfileRevision,
    destination: &crate::Profile,
    target: &crate::RetainedBuildIdentity,
) -> Result<PathBuf> {
    let port_id = &source.port_id;
    let contract = crate::portable_saves::contract_for(port_id).ok_or_else(|| {
        PortcoveError::unsupported("this game has no reviewed progress-copy contract")
    })?;
    service.require_completed_restore(port_id)?;
    let layout = Layout::for_user(&service.library.user_dir(port_id));
    let journal = layout.journal();
    crate::path::refuse_symlink_ancestors(&journal)?;
    if journal.try_exists()? {
        return Err(PortcoveError::conflict(
            "finish applying the current setup before copying progress",
        ));
    }
    // A pending runtime restore leaves canonical progress authoritative. The
    // journal and materialized revision below guard incomplete setup changes.
    let source_build = service.verified_retained_build(port_id, &revision.build.install_id)?;
    if source_build != revision.build {
        return Err(PortcoveError::conflict(
            "the source setup's exact runtime could not be verified",
        ));
    }
    let persistence_paths = service.profile_persistent_paths(port_id)?;
    let mut admitted_paths = vec![persistence_paths];
    for build in [&source_build, target] {
        let install = crate::Library::install_by_id(connection, Some(&build.install_id))?
            .ok_or_else(|| PortcoveError::state("the reviewed installation is missing"))?;
        if !contract.versions.contains(&install.version.as_str())
            || !contract.platforms.contains(&build.platform)
        {
            return Err(PortcoveError::unsupported(
                "the source or destination runtime has no reviewed progress-copy contract; choose fresh progress",
            ));
        }
        admitted_paths.push(service.installed_progress_paths(&install)?);
    }
    let root = match profile::selection(connection, port_id)? {
        Some((selected, materialized)) if selected == source.id => {
            if materialized != revision.revision {
                return Err(PortcoveError::conflict(
                    "finish applying the source setup before copying progress",
                ));
            }
            layout.user.clone()
        }
        Some(_) => layout.parked(&source.id),
        None => {
            return Err(PortcoveError::state(
                "the game has no materialized save group",
            ));
        }
    };
    let (_, saves) = crate::portable_saves::classify(contract, &root)?;
    if saves.is_empty() {
        return Err(PortcoveError::state(
            "the source setup has no supported progress to copy",
        ));
    }
    let output = layout.parked(&destination.id);
    let parent = output.parent().expect("the profile state directory");
    crate::path::refuse_symlink_ancestors(parent)?;
    fs::create_dir_all(parent)?;
    let staging = tempfile::Builder::new()
        .prefix(".copy-progress-")
        .tempdir_in(parent)?;
    for (relative, bytes) in saves {
        let top = relative
            .split('/')
            .next()
            .expect("a reviewed relative path");
        if !admitted_paths
            .iter()
            .all(|paths| paths.iter().any(|path| path == top))
        {
            return Err(PortcoveError::unsupported(
                "the installed runtimes and setup switch do not agree on the save location",
            ));
        }
        let path = staging.path().join(relative);
        fs::create_dir_all(path.parent().expect("a staged save parent"))?;
        crate::durability::write_bytes_atomically(&path, &bytes, false)?;
    }
    crate::durability::sync_publication(staging.path())?;
    crate::durability::rename_noreplace(staging.path(), &output)?;
    if let Err(error) = crate::durability::sync_publication(parent) {
        let _ = fs::remove_dir_all(&output);
        return Err(error);
    }
    Ok(output)
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

pub(crate) fn mark_restore_pending(layout: &Layout) -> Result<()> {
    fs::create_dir_all(layout.store())?;
    crate::durability::write_bytes_atomically(&layout.pending(), b"1", true)
}

enum ModPackageEdit {
    Enabled(bool),
    Remove,
}

/// A private, already-inspected copy ready to enter the package store.
pub(crate) struct StagedPackage {
    pub private: PathBuf,
    pub recomp: Option<crate::RecompModInspection>,
    pub inspection: crate::ModPackageInspection,
    pub provider: Option<crate::ProviderPackageRef>,
    pub provider_requires: Vec<crate::ProviderRequirement>,
    /// The version the package's own metadata declares, when its loader has one.
    pub native_version: Option<String>,
    /// Native IDs of packages this one needs, from its own metadata.
    pub requires: Vec<String>,
    /// True when the package runs code and the player allowed these exact bytes.
    pub code_consent: bool,
}

const MAX_CODE_CONSENTS: usize = 4096;

/// Digests the player allowed to run code in this library, for this game.
pub(crate) fn consented_code(layout: &Layout) -> Result<BTreeSet<String>> {
    let path = layout.code_consent();
    if !path.try_exists()? {
        return Ok(BTreeSet::new());
    }
    let unreadable = || {
        PortcoveError::state("the mod code consent record is not readable; repair or remove it")
            .detail("path", path.display().to_string())
    };
    if fs::metadata(&path)?.len() > (MAX_CODE_CONSENTS as u64) * 80 {
        return Err(unreadable());
    }
    let digests: BTreeSet<String> =
        serde_json::from_slice(&fs::read(&path)?).map_err(|_| unreadable())?;
    if digests.len() > MAX_CODE_CONSENTS || digests.iter().any(|sha| !is_sha256(sha)) {
        return Err(unreadable());
    }
    Ok(digests)
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

pub(crate) fn record_code_consent(layout: &Layout, sha256: &str) -> Result<()> {
    let mut digests = consented_code(layout)?;
    if !digests.insert(sha256.to_owned()) {
        return Ok(());
    }
    if digests.len() > MAX_CODE_CONSENTS {
        return Err(PortcoveError::state(
            "too many mods with allowed code are recorded",
        ));
    }
    fs::create_dir_all(layout.store())?;
    crate::durability::write_bytes_atomically(
        &layout.code_consent(),
        &serde_json::to_vec(&digests)?,
        true,
    )
}

/// What a Recomp package runs, in words a player can review.
fn describe_execution(execution: &[crate::RecompExecution]) -> String {
    execution
        .iter()
        .map(|kind| match kind {
            crate::RecompExecution::RecompiledCode => {
                "game code the Recomp runtime recompiles and runs"
            }
            crate::RecompExecution::NativeLibraries => "libraries the operating system loads",
            crate::RecompExecution::ExternalCode => "code from a separate library file",
        })
        .collect::<Vec<_>>()
        .join("; ")
}

/// Only recompiled game code, which runs inside the Recomp runtime, can be
/// allowed. Host libraries and offline packages load code outside the reviewed
/// package and stay refused.
pub(crate) fn require_admissible_code(recomp: &crate::RecompModInspection) -> Result<()> {
    if recomp
        .holds
        .contains(&crate::RecompModHold::HostExecutableFiles)
        || recomp
            .execution
            .iter()
            .any(|kind| *kind != crate::RecompExecution::RecompiledCode)
    {
        return Err(PortcoveError::unsupported(
            "this mod loads code from outside its package, such as system libraries; Portcove does not install that kind of mod; nothing was installed",
        )
        .detail("mod", &recomp.native_id)
        .detail("runs", describe_execution(&recomp.execution)));
    }
    Ok(())
}

fn code_consent_required(recomp: &crate::RecompModInspection) -> PortcoveError {
    PortcoveError::usage(
        "this mod runs its own code inside the game; it is installed only when you allow code for these exact bytes; nothing was installed",
    )
    .detail("mod", &recomp.native_id)
    .detail("runs", describe_execution(&recomp.execution))
    .detail("sha256", &recomp.sha256)
}

fn code_not_allowed(recomp: &crate::RecompModInspection) -> PortcoveError {
    PortcoveError::conflict(
        "a mod in this setup runs its own code, and code was not allowed for these exact bytes; nothing was changed. Install the same file again and allow its code, or remove the mod from the setup",
    )
    .detail("mod", &recomp.native_id)
    .detail("runs", describe_execution(&recomp.execution))
    .detail("sha256", &recomp.sha256)
}

/// Refuses a revision that would place or enable Recomp code the player did not
/// allow for its exact bytes. Checked when a revision is recorded and before a
/// switch or deployment changes anything, and again inside `deploy`. Packages
/// whose bytes are neither stored nor live are left to the missing-bytes checks.
pub(crate) fn require_code_allowed(layout: &Layout, revision: &ProfileRevision) -> Result<()> {
    require_managed_custody(revision)?;
    let Some(game) = layout.recomp_game() else {
        return Ok(());
    };
    // A readable record lets allowed bytes skip inspection; an unreadable one
    // matters only for a package that runs code, so setups without code stay usable.
    let recorded = consented_code(layout).ok();
    for package in enabled(revision) {
        // A recorded consent was only ever given to admissible code.
        if recorded
            .as_ref()
            .is_some_and(|set| set.contains(&package.sha256))
        {
            continue;
        }
        let stored = layout.package(&package.sha256, &package.native_id);
        let live = live_package_path(layout, &package.native_id)?;
        let bytes = if stored.try_exists()? {
            stored
        } else if live.try_exists()? && sha256_file(&live)? == package.sha256 {
            live
        } else {
            continue;
        };
        let recomp = crate::inspect_recomp_mod(&bytes, game)?;
        if recomp.sha256 != package.sha256 {
            return Err(PortcoveError::verification(
                "a mod's bytes changed while being checked; nothing was changed",
            )
            .detail("mod", &recomp.native_id));
        }
        if recomp.holds.contains(&crate::RecompModHold::OtherGame) {
            return Err(PortcoveError::unsupported(
                "a stored mod is made for a different game; nothing was changed",
            )
            .detail("mod", &recomp.native_id));
        }
        if recomp.execution.is_empty() && recomp.holds.is_empty() {
            continue;
        }
        require_admissible_code(&recomp)?;
        // Read strictly here: an unreadable record never counts as consent.
        if consented_code(layout)?.contains(&package.sha256) {
            continue;
        }
        return Err(code_not_allowed(&recomp));
    }
    Ok(())
}

/// What a mod package would run, shown before the player allows its code.
#[derive(
    Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, schemars::JsonSchema,
)]
pub struct ModCodeReview {
    /// The loader's identity for the mod.
    pub native_id: String,
    /// The name the mod gives itself; a claim, not verified.
    pub display_name: String,
    pub runs: Vec<crate::RecompExecution>,
    /// The exact bytes any consent covers.
    pub sha256: String,
    /// True when these bytes were already allowed in this library.
    pub already_allowed: bool,
}

/// Which code an inspected package may run: code the player allowed for these
/// bytes now (`allowed`) or before (`recorded`).
pub(crate) enum CodePolicy<'a> {
    Review,
    Consent {
        allowed: Option<&'a str>,
        recorded: &'a BTreeSet<String>,
    },
}

/// Reviews a private package copy under the port's loader contract, without
/// running anything. Recomp packages are named by their manifest mod ID.
pub(crate) fn inspect_for_port(
    layout: &Layout,
    private: PathBuf,
    provider: Option<crate::ProviderPackageRef>,
    code: CodePolicy<'_>,
) -> Result<StagedPackage> {
    let Some(game) = layout.recomp_game() else {
        let inspection = inspect_asset_archive(&private)?;
        return Ok(StagedPackage {
            private,
            recomp: None,
            inspection,
            provider,
            provider_requires: Vec::new(),
            native_version: None,
            requires: Vec::new(),
            code_consent: false,
        });
    };
    let recomp = crate::inspect_recomp_mod(&private, game)?;
    if recomp.holds.contains(&crate::RecompModHold::OtherGame) {
        return Err(PortcoveError::unsupported(
            "this mod is made for a different game; nothing was installed",
        )
        .detail("game", &recomp.game_id));
    }
    let runs_code = !recomp.holds.is_empty() || !recomp.execution.is_empty();
    if runs_code {
        require_admissible_code(&recomp)?;
        match code {
            CodePolicy::Review => {}
            CodePolicy::Consent { allowed, recorded } => {
                if allowed != Some(recomp.sha256.as_str()) && !recorded.contains(&recomp.sha256) {
                    return Err(code_consent_required(&recomp));
                }
            }
        }
    }
    let file_name = format!("{}.nrm", recomp.native_id);
    // The manifest, not a file on disk, now names the file: refuse a name some
    // supported system cannot hold before anything is stored.
    if !profile::valid_native_id(&file_name)
        || crate::archive::validate_relative_path(&file_name, false).is_err()
    {
        return Err(PortcoveError::unsupported(
            "this mod's ID cannot be used as a file name on every system Portcove supports; nothing was installed",
        )
        .detail("mod", &recomp.native_id));
    }
    // Recomp packages are reviewed through their manifest; asset paths and entry
    // counts are not compared across mods for this loader, so they stay empty.
    let inspection = crate::ModPackageInspection {
        file_name,
        sha256: recomp.sha256.clone(),
        size: recomp.size,
        entry_count: 0,
        declared_uncompressed_bytes: 0,
        asset_paths: Vec::new(),
        executable_entries: Vec::new(),
        holds: Vec::new(),
    };
    Ok(StagedPackage {
        private,
        inspection,
        provider,
        provider_requires: Vec::new(),
        native_version: Some(recomp.native_version.clone()),
        code_consent: runs_code,
        requires: recomp
            .dependencies
            .iter()
            // `.` (the mod itself) and `*` (the runtime) carry only a minimum
            // version, and built-in mods ship inside the runtime: none is a package.
            .filter(|dependency| {
                !matches!(dependency.id.as_str(), "." | "*")
                    && !layout.recomp_builtins().contains(&dependency.id.as_str())
            })
            .map(|dependency| format!("{}.nrm", dependency.id))
            .collect(),
        recomp: Some(recomp),
    })
}

/// What the live mods root holds relative to the revision that should own it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ModsObservation {
    /// Files outside the enabled packages and the reviewed empty runtime marker.
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

pub(crate) fn is_runtime_mod_marker(layout: &Layout, file_name: &str, size: u64) -> bool {
    size == 0
        && file_name == "custom_mod_files_go_here.txt"
        && matches!(layout.loader_list(), Some(LoaderList::Ship(_)))
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
        for file in profile_package_files(owner)?
            .into_iter()
            .filter(|file| file.enabled)
        {
            expected.entry(file.name).or_default().insert(file.sha256);
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
            // Shipwright 9.3.1 creates this empty file when it creates mods/.
            // It is shared runtime scaffolding and deployment leaves it in place.
            None if metadata.is_file() && is_runtime_mod_marker(layout, &name, metadata.len()) => {}
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
    require_distinct_native_names(layout, to)?;
    require_code_allowed(layout, to)?;
    let files = profile_package_files(to)?;
    let wanted = files
        .iter()
        .filter(|file| file.enabled)
        .map(|file| file.name)
        .collect::<BTreeSet<_>>();
    // Exact directory names distinguish a Windows case-only replacement from
    // a target that has already been materialized.
    let names = match fs::read_dir(layout.mods()) {
        Ok(entries) => entries
            .map(|entry| entry.map(|item| item.file_name()))
            .collect::<std::io::Result<BTreeSet<_>>>()?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => BTreeSet::new(),
        Err(error) => return Err(error.into()),
    };
    // Verify every destination first so a missing or corrupt stored package fails
    // before any departing file is removed.
    let mut to_place = Vec::new();
    for file in files.iter().filter(|file| file.enabled) {
        let live = live_package_path(layout, file.name)?;
        if names.contains(std::ffi::OsStr::new(file.name))
            && live.try_exists()?
            && sha256_file(&live)? == file.sha256
        {
            continue;
        }
        let stored = layout.package(file.sha256, file.name);
        if !stored.try_exists()? || sha256_file(&stored)? != file.sha256 {
            return Err(PortcoveError::verification(
                "stored package bytes are missing or no longer match their recorded digest; nothing was changed",
            )
            .detail("package", file.name));
        }
        to_place.push((stored, live));
    }
    if let Some(from) = from {
        require_managed_custody(from)?;
        for file in profile_package_files(from)?
            .into_iter()
            .filter(|file| file.enabled)
        {
            // Same-name replacements are atomic in stage_copy. If an earlier
            // attempt already placed the target, leave those target bytes in place.
            if !wanted.contains(file.name) && names.contains(std::ffi::OsStr::new(file.name)) {
                let live = live_package_path(layout, file.name)?;
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

/// Refuses a revision this game could not load unambiguously: two enabled
/// packages with the same loader name, or a name its list cannot carry. Checked
/// when a revision is created and before any change starts, so nothing is parked,
/// marked or deployed for a revision that would fail part way.
pub(crate) fn require_projectable(layout: &Layout, revision: &ProfileRevision) -> Result<()> {
    if layout.loader_list().is_none() {
        return Ok(());
    }
    let on = enabled(revision)
        .map(|package| package.native_id.as_str())
        .collect::<BTreeSet<_>>();
    for package in enabled(revision) {
        if let Some(missing) = package.requires.iter().find(|id| !on.contains(id.as_str())) {
            let installed = revision
                .packages
                .iter()
                .any(|candidate| &candidate.native_id == missing);
            let message = if installed {
                "a mod that is on needs another mod that is off; turn that one on first, or turn this one off. Nothing was changed"
            } else {
                "this mod needs another mod that is not installed; install that one first. Nothing was changed"
            };
            return Err(PortcoveError::conflict(message)
                .detail("mod", native_mod_list::native_name(&package.native_id))
                .detail("needs", native_mod_list::native_name(missing)));
        }
    }
    for package in enabled(revision) {
        native_mod_list::require_listable(&package.native_id)?;
    }
    if let Some((first, second)) = native_mod_list::identity_collision(
        enabled(revision).map(|package| package.native_id.as_str()),
    ) {
        return Err(PortcoveError::conflict(
            "two enabled packages would load as the same mod; turn one of them off. Nothing was changed",
        )
        .detail("packages", format!("{first}, {second}")));
    }
    Ok(())
}

fn require_distinct_native_names(layout: &Layout, revision: &ProfileRevision) -> Result<()> {
    require_projectable(layout, revision)
}

/// The revision's enabled packages in `asset-override` order, as deployed: each
/// keeps its place when replaced, and packages the ordering does not name follow.
pub(crate) fn enabled_in_override_order(revision: &ProfileRevision) -> Vec<&ResolvedPackage> {
    let mut ordered = revision
        .orderings
        .iter()
        .find(|ordering| ordering.domain == OVERRIDE_DOMAIN)
        .map(|ordering| {
            ordering
                .native_ids
                .iter()
                .filter_map(|id| enabled(revision).find(|package| &package.native_id == id))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for package in enabled(revision) {
        if !ordered
            .iter()
            .any(|seen| seen.native_id == package.native_id)
        {
            ordered.push(package);
        }
    }
    ordered
}

/// The revision's enabled packages as the loader names them, in the
/// `asset-override` order (last wins, matching the native list).
pub(crate) fn native_projection(revision: &ProfileRevision) -> Vec<String> {
    let enabled_ids = enabled(revision)
        .map(|package| package.native_id.as_str())
        .collect::<Vec<_>>();
    let mut order = revision
        .orderings
        .iter()
        .find(|ordering| ordering.domain == OVERRIDE_DOMAIN)
        .map(|ordering| {
            ordering
                .native_ids
                .iter()
                .filter(|id| enabled_ids.contains(&id.as_str()))
                .map(String::as_str)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for id in enabled_ids {
        if !order.contains(&id) {
            order.push(id);
        }
    }
    order
        .into_iter()
        .map(|id| native_mod_list::native_name(id).to_owned())
        .collect()
}

/// Loader names of every package the revision owns, enabled or not. Other list
/// entries belong to the player (their own files in `mods`) and are never moved.
/// Compared without case, as the game treats names that differ only in case as
/// one mod; an entry left by a replaced package (`Link` for `link.o2r`) is the
/// profile's, not the player's.
fn managed_names(revision: &ProfileRevision) -> BTreeSet<String> {
    revision
        .packages
        .iter()
        .map(|package| native_mod_list::native_name(&package.native_id).to_lowercase())
        .collect()
}

/// The game's list with only the revision's own entries replaced: managed slots
/// take the revision's enabled packages in order, extra ones are appended, and
/// every entry the player owns keeps its position.
fn merged_list(
    existing: &[String],
    revision: &ProfileRevision,
    managed: &BTreeSet<String>,
) -> Vec<String> {
    let mut wanted = native_projection(revision).into_iter();
    let mut merged = Vec::new();
    for entry in existing {
        if managed.contains(&entry.to_lowercase()) {
            if let Some(next) = wanted.next() {
                merged.push(next);
            }
        } else {
            merged.push(entry.clone());
        }
    }
    merged.extend(wanted);
    merged
}

/// How the game's own mod list relates to the selected revision.
#[derive(
    Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize, schemars::JsonSchema,
)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum NativeModListStatus {
    /// This game has no reviewed native mod list.
    #[default]
    NotApplicable,
    /// The list names the enabled packages in the revision's order. Entries for
    /// the player's own files are not compared.
    InSync,
    /// No list yet; Portcove writes it before the next launch.
    NotWritten,
    /// The same mods in a different order, set in the game's menu. Portcove keeps
    /// it as the profile's next revision when supervised play ends, or at the next
    /// profile change or launch.
    Reordered { native_order: Vec<String> },
    /// The native enabled set differs. Supported disables can become a new
    /// revision. Ambiguous entries stay visible for review.
    Differs {
        missing: Vec<String>,
        unexpected: Vec<String>,
    },
    /// The configuration could not be read; Portcove leaves it untouched.
    Unreadable { reason: String },
}

/// What the game's own list loads, in load order, one name per enabled mod.
enum LiveList {
    NotWritten,
    Unreadable(String),
    Loads {
        names: Vec<String>,
        from_backup: bool,
    },
}

fn read_live_list(user: &Path, list: LoaderList) -> LiveList {
    match list {
        LoaderList::Ship(contract) => match native_mod_list::read(user, &contract) {
            NativeList::Absent | NativeList::Unlisted => LiveList::NotWritten,
            // Ship's Clear List requests a rebuilt order on restart. Its
            // reviewed menu has no per-package enable/disable control.
            NativeList::Listed(names) if names.is_empty() => LiveList::NotWritten,
            NativeList::Unreadable(reason) => LiveList::Unreadable(reason),
            NativeList::Listed(names) => LiveList::Loads {
                names,
                from_backup: false,
            },
        },
        LoaderList::Recomp => match crate::recomp_mod_list::read(user) {
            crate::recomp_mod_list::RecompList::Absent => LiveList::NotWritten,
            crate::recomp_mod_list::RecompList::Unreadable(reason) => LiveList::Unreadable(reason),
            crate::recomp_mod_list::RecompList::Listed {
                enabled_list_present: false,
                ..
            } => LiveList::NotWritten,
            crate::recomp_mod_list::RecompList::Listed {
                enabled,
                order,
                from_backup,
                ..
            } => {
                if from_backup && enabled.iter().any(|id| !order.contains(id)) {
                    return LiveList::Unreadable(
                        "the backup mod list has enabled entries without a recorded order".into(),
                    );
                }
                // The runtime places enabled mods it has no order for before the
                // ordered ones.
                let on = enabled.iter().collect::<BTreeSet<_>>();
                let mut loads = enabled
                    .iter()
                    .filter(|id| !order.contains(id))
                    .cloned()
                    .collect::<Vec<_>>();
                loads.extend(order.iter().filter(|id| on.contains(id)).cloned());
                LiveList::Loads {
                    names: loads,
                    from_backup,
                }
            }
        },
    }
}

fn native_status(layout: &Layout, revision: &ProfileRevision) -> NativeModListStatus {
    native_status_at(&layout.user, layout, revision)
}

fn native_status_at(
    user: &Path,
    layout: &Layout,
    revision: &ProfileRevision,
) -> NativeModListStatus {
    let Some(list) = layout.loader_list() else {
        return NativeModListStatus::NotApplicable;
    };
    native_status_from_list(read_live_list(user, list), revision)
}

fn native_status_from_list(list: LiveList, revision: &ProfileRevision) -> NativeModListStatus {
    let expected = native_projection(revision);
    let managed = managed_names(revision);
    match list {
        LiveList::NotWritten => NativeModListStatus::NotWritten,
        LiveList::Unreadable(reason) => NativeModListStatus::Unreadable { reason },
        LiveList::Loads { names, .. } => {
            let listed = filter_managed_names(names, &managed);
            if listed == expected {
                return NativeModListStatus::InSync;
            }
            let mut sorted_listed = listed.clone();
            sorted_listed.sort();
            let mut sorted_expected = expected.clone();
            sorted_expected.sort();
            if sorted_listed == sorted_expected {
                return NativeModListStatus::Reordered {
                    native_order: listed,
                };
            }
            let wanted = expected.iter().collect::<BTreeSet<_>>();
            let found = listed.iter().collect::<BTreeSet<_>>();
            NativeModListStatus::Differs {
                missing: wanted
                    .difference(&found)
                    .map(|name| (*name).clone())
                    .collect(),
                unexpected: found
                    .difference(&wanted)
                    .map(|name| (*name).clone())
                    .collect(),
            }
        }
    }
}

fn unreadable_recomp_list_hold(reason: &str) -> PortcoveError {
    PortcoveError::conflict(
        "The game's mod list needs review. Keep both mod list files and review the selected setup before playing.",
    )
    .detail("native_list", reason)
    .with_known_cause(crate::failure::KnownFailureCause::NativeModListReview)
}

fn restore_projection_hold(revision: &ProfileRevision) -> PortcoveError {
    let next_step = if crate::portable_saves::contract_for(&revision.build.port_id).is_some() {
        "Use a backup that matches this setup, or use save-only import for progress."
    } else {
        "Select the matching setup or choose another backup."
    };
    PortcoveError::conflict(format!(
        "A full backup restore would change the selected setup's mods or settings. {next_step}"
    ))
    .detail("profile_id", &revision.profile_id)
    .detail("revision", revision.revision.to_string())
}

fn require_exact_managed_packages(
    root: &Path,
    layout: &Layout,
    revision: &ProfileRevision,
    hold: impl Fn() -> PortcoveError,
) -> Result<()> {
    let mut remaining = profile_package_files(revision)?
        .into_iter()
        .filter(|file| file.enabled)
        .map(|file| (file.name, file))
        .collect::<std::collections::BTreeMap<_, _>>();
    let mods = root.join(MODS);
    crate::path::refuse_symlink_ancestors(&mods)?;
    let ship_loader = matches!(layout.loader_list(), Some(LoaderList::Ship(_)));
    match fs::read_dir(&mods) {
        Ok(entries) => {
            for entry in entries {
                let entry = entry?;
                let file_name = entry.file_name();
                let name = file_name
                    .to_str()
                    .ok_or_else(|| hold().detail("unknown_package", file_name.to_string_lossy()))?;
                let path = entry.path();
                if let Some(package) = remaining.remove(name) {
                    let observed =
                        crate::external_runtime::hash_stable_regular(&path, package.size, &|| {
                            Ok(())
                        });
                    if !observed.is_ok_and(|(sha256, size)| {
                        sha256 == package.sha256 && size == package.size
                    }) {
                        return Err(hold().detail("changed_package", name));
                    }
                } else if !(ship_loader
                    && name == "custom_mod_files_go_here.txt"
                    && crate::external_runtime::hash_stable_regular(&path, 0, &|| Ok(())).is_ok())
                {
                    return Err(hold().detail("unknown_package", name));
                }
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    if let Some((name, _)) = remaining.first_key_value() {
        return Err(hold().detail("missing_package", *name));
    }
    Ok(())
}

impl PortcoveService {
    /// Validates a full backup's projected setup without changing the backup or granting consent.
    /// The caller holds the port lock across this check and publication.
    pub(crate) fn require_restore_profile_projection(
        &self,
        port_id: &str,
        root: &Path,
    ) -> Result<()> {
        self.require_no_switch_journal(port_id)?;
        crate::profile_file_preservation::require_idle(&self.library, port_id)?;
        let Some(layout) = self.optional_deploy_layout(port_id)? else {
            return Ok(());
        };
        let connection = self.library.connection()?;
        let Some((profile_id, number)) = profile::selection(&connection, port_id)? else {
            return Ok(());
        };
        let revision = profile::revision_by_number(&connection, &profile_id, number)?;
        let journal = layout.journal();
        crate::path::refuse_symlink_ancestors(&journal)?;
        if journal.try_exists()?
            || profile::profile_by_id(&connection, port_id, &profile_id)?.current_revision != number
        {
            return Err(restore_projection_hold(&revision).detail("setup_change_pending", "true"));
        }
        require_exact_managed_packages(root, &layout, &revision, || {
            restore_projection_hold(&revision)
        })?;
        match native_status_at(root, &layout, &revision) {
            NativeModListStatus::InSync => {}
            NativeModListStatus::NotWritten if enabled(&revision).next().is_none() => {}
            _ => {
                return Err(restore_projection_hold(&revision)
                    .detail("native_list", "differs_or_unreadable"));
            }
        }
        if let Some(game) = layout.recomp_game() {
            let captured = crate::recomp_mod_settings::capture(root, &layout, game, &revision)
                .map_err(|error| {
                    restore_projection_hold(&revision).detail("mod_settings", error.message)
                })?;
            if captured != revision.settings {
                return Err(restore_projection_hold(&revision).detail("mod_settings", "differs"));
            }
        }
        Ok(())
    }
}

fn filter_managed_names(names: Vec<String>, managed: &BTreeSet<String>) -> Vec<String> {
    names
        .into_iter()
        .filter(|name| managed.contains(&name.to_lowercase()))
        .collect()
}

/// The override order after a native edit; disabled packages keep their
/// relative place at the end. None when
/// the list cannot be mapped one-to-one onto the revision's packages.
fn adopted_order(
    revision: &ProfileRevision,
    native_order: &[String],
) -> Option<Vec<TypedOrdering>> {
    let mut order = Vec::new();
    for name in native_order {
        let id = enabled(revision)
            .find(|package| native_mod_list::native_name(&package.native_id) == name)?
            .native_id
            .clone();
        if order.contains(&id) {
            return None;
        }
        order.push(id);
    }
    let previous = revision
        .orderings
        .iter()
        .find(|ordering| ordering.domain == OVERRIDE_DOMAIN)
        .map(|ordering| ordering.native_ids.clone())
        .unwrap_or_default();
    for id in previous.into_iter().chain(
        revision
            .packages
            .iter()
            .map(|package| package.native_id.clone()),
    ) {
        if !order.contains(&id) {
            order.push(id);
        }
    }
    let mut orderings = revision
        .orderings
        .iter()
        .filter(|ordering| ordering.domain != OVERRIDE_DOMAIN)
        .cloned()
        .collect::<Vec<_>>();
    orderings.push(TypedOrdering {
        domain: OVERRIDE_DOMAIN.into(),
        native_ids: order,
    });
    Some(orderings)
}

fn declared_state_paths(service: &PortcoveService, port_id: &str) -> Result<Vec<String>> {
    Ok(service
        .profile_persistent_paths(port_id)?
        .into_iter()
        .filter(|path| path != MODS)
        .collect())
}

pub(crate) fn live_package_path(layout: &Layout, native_id: &str) -> Result<PathBuf> {
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

fn write_journal(
    layout: &Layout,
    from: &str,
    to: &str,
    revision: u64,
    phase: Phase,
    paths: &[String],
) -> Result<()> {
    let journal = serde_json::json!({
        "from": from, "to": to, "revision": revision, "phase": phase.name(), "paths": paths,
    });
    crate::durability::write_bytes_atomically(
        &layout.journal(),
        journal.to_string().as_bytes(),
        true,
    )
}

/// Exact review of a file chosen for one setup. Paths stay local to the caller.
#[derive(
    Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, schemars::JsonSchema,
)]
pub struct LocalModPackagePlan {
    pub profile_id: String,
    pub expected_revision: u64,
    pub native_id: String,
    pub sha256: String,
    pub size: u64,
    pub asset_count: usize,
    pub replaces: Vec<String>,
    pub replaces_enabled: bool,
    pub overlapping_mods: Vec<String>,
    pub conflicts_truncated: bool,
    pub needs_code_permission: bool,
    pub required_mods: Vec<String>,
    pub missing_required_mods: Vec<String>,
    pub plan_sha256: String,
}

fn copy_local_package(layout: &Layout, source: &Path) -> Result<(tempfile::TempDir, PathBuf)> {
    use crate::mod_package::MAX_ARCHIVE_BYTES;
    crate::path::refuse_symlink_ancestors(source)?;
    let invalid =
        || PortcoveError::unsupported("choose a regular mod archive within the size limit");
    let metadata = fs::symlink_metadata(source)?;
    if !metadata.is_file() || metadata.len() > MAX_ARCHIVE_BYTES {
        return Err(invalid());
    }
    let file_name = source.file_name().ok_or_else(invalid)?;
    crate::path::refuse_symlink_ancestors(&layout.tmp())?;
    fs::create_dir_all(layout.tmp())?;
    let staging = tempfile::tempdir_in(layout.tmp())?;
    let private = staging.path().join(file_name);
    let mut output = fs::File::create(&private)?;
    crate::external_runtime::stream_single_link_metadata(
        source,
        MAX_ARCHIVE_BYTES,
        &|| Ok(()),
        &mut |bytes| output.write_all(bytes).map_err(Into::into),
    )?;
    Ok((staging, private))
}

fn validate_staged_mod(layout: &Layout, inspection: &crate::ModPackageInspection) -> Result<()> {
    if layout.loader_list().is_some() {
        native_mod_list::require_listable(&inspection.file_name)?;
    }
    let extensions = layout.package_extensions();
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
    Ok(())
}

fn plan_local_mod_package(
    layout: &Layout,
    current: &ProfileRevision,
    staged: &StagedPackage,
    recorded_code: &BTreeSet<String>,
) -> Result<LocalModPackagePlan> {
    use sha2::{Digest, Sha256};
    let inspection = &staged.inspection;
    validate_staged_mod(layout, inspection)?;
    let named_loader = layout.loader_list().is_some();
    let replaces = current
        .packages
        .iter()
        .filter(|package| {
            package.native_id == inspection.file_name
                || (named_loader
                    && native_mod_list::same_mod(&package.native_id, &inspection.file_name))
        })
        .collect::<Vec<_>>();
    let replaces_enabled = replaces.iter().all(|package| package.enabled);
    let assets = inspection.asset_paths.iter().collect::<BTreeSet<_>>();
    let mut overlapping_mods = Vec::new();
    let mut conflicts_truncated = false;
    let mut comparison_bytes = 0u64;
    if replaces_enabled && !assets.is_empty() {
        for (index, package) in current
            .packages
            .iter()
            .filter(|package| package.enabled && !replaces.contains(package))
            .enumerate()
        {
            comparison_bytes = comparison_bytes.saturating_add(package.size);
            if index >= 64 || comparison_bytes > crate::mod_package::MAX_ARCHIVE_BYTES {
                conflicts_truncated = true;
                break;
            }
            let path = layout.package(&package.sha256, &package.native_id);
            let observed = inspect_asset_archive(&path)?;
            if observed.sha256 != package.sha256 || observed.size != package.size {
                return Err(
                    PortcoveError::verification("a current mod changed before comparison")
                        .detail("mod", &package.native_id),
                );
            }
            if observed
                .asset_paths
                .iter()
                .any(|asset| assets.contains(asset))
            {
                overlapping_mods.push(package.native_id.clone());
            }
        }
    }
    let builtins = layout.recomp_builtins();
    let missing_required_mods: Vec<String> = staged
        .requires
        .iter()
        .filter(|id| {
            replaces_enabled
                && !builtins.contains(&native_mod_list::native_name(id))
                && !current
                    .packages
                    .iter()
                    .any(|package| package.enabled && package.native_id == **id)
        })
        .cloned()
        .collect();
    let mut plan = LocalModPackagePlan {
        profile_id: current.profile_id.clone(),
        expected_revision: current.revision,
        native_id: inspection.file_name.clone(),
        sha256: inspection.sha256.clone(),
        size: inspection.size,
        asset_count: inspection.asset_paths.len(),
        replaces: replaces
            .iter()
            .map(|package| package.native_id.clone())
            .collect(),
        replaces_enabled,
        overlapping_mods,
        conflicts_truncated,
        needs_code_permission: missing_required_mods.is_empty()
            && staged.code_consent
            && !recorded_code.contains(&inspection.sha256),
        required_mods: staged.requires.clone(),
        missing_required_mods,
        plan_sha256: String::new(),
    };
    plan.plan_sha256 = hex::encode(Sha256::digest(serde_json::to_vec(&plan)?));
    Ok(plan)
}

enum RuntimeSynchronization {
    Eager,
    OnLaunch,
}

impl PortcoveService {
    pub(crate) fn optional_deploy_layout(&self, port_id: &str) -> Result<Option<Layout>> {
        let connection = self.library.connection()?;
        if let Some((id, number)) = profile::selection(&connection, port_id)? {
            let revision = profile::revision_by_number(&connection, &id, number)?;
            return self.layout_for_revision(&revision);
        }
        let Some(id) = profile::active_install_id(&connection, port_id)? else {
            return Ok(None);
        };
        let install = crate::Library::install_by_id(&connection, Some(&id))?
            .filter(|install| install.port_id == port_id)
            .ok_or_else(|| {
                PortcoveError::verification(
                    "the active installation record is missing or out of scope",
                )
            })?;
        self.layout_for_install(&install)
    }

    pub(crate) fn deploy_layout(&self, port_id: &str) -> Result<Layout> {
        self.optional_deploy_layout(port_id)?.ok_or_else(|| {
            PortcoveError::unsupported("the selected build has no reviewed mod loader")
        })
    }

    pub(crate) fn require_no_switch_journal(&self, port_id: &str) -> Result<()> {
        let journal = Layout::for_user(&self.library.user_dir(port_id)).journal();
        crate::path::refuse_symlink_ancestors(&journal)?;
        if journal.try_exists()? {
            return Err(PortcoveError::conflict(
                "a profile switch was interrupted; finish it before using this setup",
            ));
        }
        Ok(())
    }

    /// Examines a private copy and binds the facts to the displayed setup revision.
    pub fn plan_local_mod_package(
        &self,
        port_id: &str,
        profile_id: &str,
        source: &Path,
        expected_revision: u64,
    ) -> Result<LocalModPackagePlan> {
        self.inspect_local_mod_selection(port_id, profile_id, source, expected_revision, false)
    }

    /// Checks a file for queueing. The complete draft establishes dependency versions.
    pub fn plan_workspace_local_mod_package(
        &self,
        port_id: &str,
        profile_id: &str,
        source: &Path,
        expected_revision: u64,
    ) -> Result<LocalModPackagePlan> {
        self.inspect_local_mod_selection(port_id, profile_id, source, expected_revision, true)
    }

    fn inspect_local_mod_selection(
        &self,
        port_id: &str,
        profile_id: &str,
        source: &Path,
        expected_revision: u64,
        workspace: bool,
    ) -> Result<LocalModPackagePlan> {
        let _guard = self
            .library
            .try_read_lock_port(port_id, "plan-local-mod-package")?;
        let current = profile_current(&self.library.connection()?, port_id, profile_id)?;
        if current.revision != expected_revision {
            return Err(PortcoveError::conflict(
                "the setup changed; review this file again",
            ));
        }
        let layout = self.require_layout_for_revision(&current)?;
        let (_staging, private) = copy_local_package(&layout, source)?;
        let staged = inspect_for_port(&layout, private, None, CodePolicy::Review)?;
        let recorded = consented_code(&layout).unwrap_or_default();
        let plan = plan_local_mod_package(&layout, &current, &staged, &recorded)?;
        if !workspace && let Some(recomp) = &staged.recomp {
            self.review_recomp_changes(
                &layout,
                &current,
                [recomp],
                Some((&recomp.native_id, &plan.missing_required_mods)),
            )?;
        }
        Ok(plan)
    }

    /// Installs the reviewed bytes, with a separate decision for exact code.
    pub fn apply_local_mod_package(
        &self,
        port_id: &str,
        profile_id: &str,
        source: &Path,
        expected_plan_sha256: &str,
        allow_code: bool,
    ) -> Result<ProfileRevision> {
        let layout = self.deploy_layout(port_id)?;
        let _guard = self
            .library
            .try_lock_port(port_id, "apply-local-mod-package")?;
        self.recover_switch_locked(port_id, &layout)?;
        let current = profile_current(&self.library.connection()?, port_id, profile_id)?;
        let layout = self.require_layout_for_revision(&current)?;
        let (_staging, private) = copy_local_package(&layout, source)?;
        let staged = inspect_for_port(&layout, private, None, CodePolicy::Review)?;
        let recorded = consented_code(&layout).unwrap_or_default();
        let plan = plan_local_mod_package(&layout, &current, &staged, &recorded)?;
        if plan.plan_sha256 != expected_plan_sha256 {
            return Err(PortcoveError::conflict(
                "the package or setup changed; review it again",
            ));
        }
        if !plan.missing_required_mods.is_empty() {
            return Err(PortcoveError::conflict(
                "add or enable the required mods before installing this one",
            )
            .detail("requires", plan.missing_required_mods.join(", ")));
        }
        self.review_recomp_changes(&layout, &current, staged.recomp.as_ref(), None)?;
        if plan.needs_code_permission && !allow_code {
            return Err(PortcoveError::usage(
                "this exact mod package needs permission to run code",
            ));
        }
        if plan.needs_code_permission {
            record_code_consent(&layout, &plan.sha256)?;
        }
        self.install_staged_locked(port_id, profile_id, current.revision, vec![staged])
    }

    pub(crate) fn inspect_local_draft_file(
        &self,
        layout: &Layout,
        current: &ProfileRevision,
        file: &LocalModDraftFile,
        allow_code: bool,
    ) -> Result<(tempfile::TempDir, StagedPackage)> {
        let (staging, private) = copy_local_package(layout, &file.path)?;
        let staged = inspect_for_port(layout, private, None, CodePolicy::Review)?;
        let recorded = consented_code(layout).unwrap_or_default();
        let plan = plan_local_mod_package(layout, current, &staged, &recorded)?;
        if plan.plan_sha256 != file.expected_plan_sha256 {
            return Err(PortcoveError::conflict(
                "the local file or setup changed; review the file again",
            ));
        }
        if staged.code_consent && !recorded.contains(&staged.inspection.sha256) && !allow_code {
            return Err(PortcoveError::usage(
                "this exact mod package needs permission to run code",
            ));
        }
        Ok((staging, staged))
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
        self.install_mod_package_with(port_id, profile_id, source, expected_revision, None)
    }

    /// Reads what a local package would run, before the player decides whether
    /// to install it. `None` when it runs no code (or the game has no loader that
    /// runs mod code); refuses code no consent can admit. Reads a private copy
    /// and changes nothing; the install inspects its own copy again and binds
    /// consent to the digest shown here.
    pub fn review_mod_package_code(
        &self,
        port_id: &str,
        source: &Path,
    ) -> Result<Option<ModCodeReview>> {
        let layout = self.deploy_layout(port_id)?;
        let Some(game) = layout.recomp_game() else {
            return Ok(None);
        };
        fs::create_dir_all(layout.tmp())?;
        let staging = tempfile::tempdir_in(layout.tmp())?;
        let file_name = source
            .file_name()
            .ok_or_else(|| PortcoveError::usage("the package path has no file name"))?;
        let private = staging.path().join(file_name);
        fs::copy(source, &private)?;
        let recomp = crate::inspect_recomp_mod(&private, game)?;
        if recomp.holds.contains(&crate::RecompModHold::OtherGame)
            || (recomp.execution.is_empty() && recomp.holds.is_empty())
        {
            return Ok(None);
        }
        require_admissible_code(&recomp)?;
        Ok(Some(ModCodeReview {
            native_id: recomp.native_id,
            display_name: recomp.display_name,
            runs: recomp.execution,
            already_allowed: consented_code(&layout)
                .unwrap_or_default()
                .contains(&recomp.sha256),
            sha256: recomp.sha256,
        }))
    }

    /// Like [`Self::install_mod_package`], and the player allows the package to
    /// run its own code. The consent names the package's SHA-256: other bytes,
    /// including a later version, need their own consent. It records the
    /// player's choice; it does not establish that the code is safe or who
    /// wrote it.
    pub fn install_mod_package_allowing_code(
        &self,
        port_id: &str,
        profile_id: &str,
        source: &Path,
        expected_revision: u64,
        code_sha256: &str,
    ) -> Result<ProfileRevision> {
        if !is_sha256(code_sha256) {
            return Err(PortcoveError::usage(
                "allowing mod code needs the package's lowercase SHA-256",
            ));
        }
        self.install_mod_package_with(
            port_id,
            profile_id,
            source,
            expected_revision,
            Some(code_sha256),
        )
    }

    fn install_mod_package_with(
        &self,
        port_id: &str,
        profile_id: &str,
        source: &Path,
        expected_revision: u64,
        allow_code_sha256: Option<&str>,
    ) -> Result<ProfileRevision> {
        let layout = self.deploy_layout(port_id)?;
        let _guard = self.library.try_lock_port(port_id, "install-mod-package")?;
        // Copy first, then inspect and store the private copy only, so the bytes that
        // were reviewed are the bytes that are kept.
        fs::create_dir_all(layout.tmp())?;
        let staging = tempfile::tempdir_in(layout.tmp())?;
        let file_name = source
            .file_name()
            .ok_or_else(|| PortcoveError::usage("the package path has no file name"))?;
        let private = staging.path().join(file_name);
        fs::copy(source, &private)?;
        // An unreadable record allows nothing, and mods without code need none.
        let recorded = consented_code(&layout).unwrap_or_default();
        let staged = inspect_for_port(
            &layout,
            private,
            None,
            CodePolicy::Consent {
                allowed: allow_code_sha256,
                recorded: &recorded,
            },
        )?;
        // Consent is the player's choice for these inspected bytes. It is kept
        // before any interrupted change is finished, so allowing the same file
        // again can complete a change that was held for it.
        if staged.code_consent {
            record_code_consent(&layout, &staged.inspection.sha256)?;
        }
        self.recover_switch_locked(port_id, &layout)?;
        self.install_staged_locked(port_id, profile_id, expected_revision, vec![staged])
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
        if staged.is_empty() {
            return Err(PortcoveError::usage("there are no packages to install"));
        }
        self.apply_mod_setup_draft_locked(port_id, profile_id, expected_revision, staged, None)
    }

    pub(crate) fn apply_mod_setup_draft_locked(
        &self,
        port_id: &str,
        profile_id: &str,
        expected_revision: u64,
        staged: Vec<StagedPackage>,
        edits: Option<&ModSetupEdits>,
    ) -> Result<ProfileRevision> {
        let layout = self.deploy_layout(port_id)?;
        let connection = self.library.connection()?;
        let current = profile_current(&connection, port_id, profile_id)?;
        if edits.is_some() && current.revision != expected_revision {
            return Err(PortcoveError::conflict(
                "the setup changed; review the changes again",
            ));
        }
        require_reviewed_or_reordered(&connection, &current, expected_revision)?;
        let selected = profile::selection(&connection, port_id)?;
        let live = selected.as_ref().is_some_and(|(id, _)| id == profile_id);
        if live {
            self.reconcile_selected(port_id, &layout, &connection, &current)?;
            require_clean(&observe(&layout, &[&current])?, "installing a package")?;
        }
        let next = proposed_mod_setup(&layout, &current, &staged, edits)?;
        let mut draft_consent = Vec::new();
        for item in staged {
            let inspection = &item.inspection;
            if edits.is_some() && item.code_consent {
                draft_consent.push(inspection.sha256.clone());
            }
            let stored = layout.package(&inspection.sha256, &inspection.file_name);
            if !stored.try_exists()? || sha256_file(&stored)? != inspection.sha256 {
                // A draft's reviewed provider files must remain inspectable if
                // publishing the revision fails and the player retries.
                if edits.is_some() && item.provider.is_some() {
                    stage_copy(&layout, &item.private, &stored)?;
                } else {
                    if let Some(parent) = stored.parent() {
                        fs::create_dir_all(parent)?;
                    }
                    if stored.try_exists()? {
                        fs::remove_file(&stored)?;
                    }
                    fs::rename(&item.private, &stored)?;
                }
                if sha256_file(&stored)? != inspection.sha256 {
                    let _ = fs::remove_file(&stored);
                    return Err(PortcoveError::verification(
                        "package bytes changed while being stored; nothing was installed",
                    ));
                }
            }
        }
        if edits.is_some() {
            self.require_revision_loader(&next)?;
            if live && let Some(game) = layout.recomp_game() {
                crate::recomp_mod_settings::review_projection(&layout.user, &layout, game, &next)?;
            }
            for sha in draft_consent {
                record_code_consent(&layout, &sha)?;
            }
        }
        let request = ProfileRevisionRequest {
            expected_revision: current.revision,
            packages: Some(next.packages),
            orderings: Some(next.orderings),
            ..Default::default()
        };
        let synchronization = if edits.is_some() {
            RuntimeSynchronization::OnLaunch
        } else {
            RuntimeSynchronization::Eager
        };
        self.advance_and_deploy(
            port_id,
            profile_id,
            &layout,
            &request,
            live,
            synchronization,
        )
        .map_err(|mut error| {
            if edits.is_some() && error.failure.mutation_state == crate::MutationState::Committed {
                error.failure.mutation_state = crate::MutationState::RecoveryRequired;
            }
            error
        })
    }

    /// Enables or disables an installed package as a new revision.
    pub fn set_mod_package_enabled(
        &self,
        port_id: &str,
        profile_id: &str,
        native_id: &str,
        enabled: bool,
        expected_revision: u64,
    ) -> Result<ProfileRevision> {
        self.edit_mod_package(
            port_id,
            profile_id,
            native_id,
            ModPackageEdit::Enabled(enabled),
            expected_revision,
        )
    }

    /// Removes a package from this setup. Historical revisions retain its bytes.
    pub fn remove_mod_package(
        &self,
        port_id: &str,
        profile_id: &str,
        native_id: &str,
        expected_revision: u64,
    ) -> Result<ProfileRevision> {
        self.edit_mod_package(
            port_id,
            profile_id,
            native_id,
            ModPackageEdit::Remove,
            expected_revision,
        )
    }

    fn edit_mod_package(
        &self,
        port_id: &str,
        profile_id: &str,
        native_id: &str,
        edit: ModPackageEdit,
        expected_revision: u64,
    ) -> Result<ProfileRevision> {
        let layout = self.deploy_layout(port_id)?;
        let operation = match edit {
            ModPackageEdit::Enabled(_) => "set-mod-enabled",
            ModPackageEdit::Remove => "remove-mod-package",
        };
        let _guard = self.library.try_lock_port(port_id, operation)?;
        self.recover_switch_locked(port_id, &layout)?;
        let connection = self.library.connection()?;
        let current = profile_current(&connection, port_id, profile_id)?;
        require_reviewed_or_reordered(&connection, &current, expected_revision)?;

        let mut packages = current.packages.clone();
        let index = packages
            .iter()
            .position(|package| package.native_id == native_id)
            .ok_or_else(|| PortcoveError::not_found("the profile has no such package"))?;
        let orderings = match edit {
            ModPackageEdit::Enabled(enabled) => {
                if packages[index].enabled == enabled {
                    return Ok(current);
                }
                packages[index].enabled = enabled;
                None
            }
            ModPackageEdit::Remove => {
                packages.remove(index);
                let mut orderings = current.orderings.clone();
                for ordering in &mut orderings {
                    ordering.native_ids.retain(|id| id != native_id);
                }
                Some(orderings)
            }
        };
        let selected = profile::selection(&connection, port_id)?;
        let live = selected.as_ref().is_some_and(|(id, _)| id == profile_id);
        if live {
            self.reconcile_selected(port_id, &layout, &connection, &current)?;
            require_clean(&observe(&layout, &[&current])?, "changing a package")?;
        }
        let request = ProfileRevisionRequest {
            expected_revision: current.revision,
            packages: Some(packages),
            orderings,
            ..Default::default()
        };
        self.advance_and_deploy(
            port_id,
            profile_id,
            &layout,
            &request,
            live,
            RuntimeSynchronization::Eager,
        )
    }

    /// Makes a profile that already exists the owner of live data. Departing and
    /// arriving progress move whole; mods are reconciled from the exact revision.
    pub fn activate_profile(&self, port_id: &str, profile_id: &str) -> Result<ProfileRevision> {
        self.catalog().port(port_id)?;
        let path_layout = Layout::for_user(&self.library.user_dir(port_id));
        let _guard = self.library.try_lock_port(port_id, "activate-profile")?;
        self.recover_switch_locked(port_id, &path_layout)?;
        let connection = self.library.connection()?;
        let target = profile_current(&connection, port_id, profile_id)?;
        let Some((current_id, current_revision)) = profile::selection(&connection, port_id)? else {
            return Err(PortcoveError::state(
                "the port has no selected profile; create its default profile first",
            ));
        };
        let departing = profile::revision_by_number(&connection, &current_id, current_revision)?;
        let target_layout = self.layout_for_revision(&target)?;
        let departing_layout = self.layout_for_revision(&departing)?;
        if departing_layout.is_none() && target_layout.is_none() {
            return Err(PortcoveError::unsupported(
                "neither setup has a reviewed mod loader",
            ));
        }
        let layout = target_layout.as_ref().unwrap_or(&path_layout);
        // Refuse before anything is parked or marked, so a refusal changes nothing.
        self.require_revision_loader(&target)?;
        require_projectable(layout, &target)?;
        require_code_allowed(layout, &target)?;
        if let Some(game) = layout.recomp_game()
            && (current_id != profile_id || current_revision != target.revision)
        {
            let user = if current_id == profile_id {
                layout.user.clone()
            } else {
                layout.parked(profile_id)
            };
            crate::recomp_mod_settings::review_projection(&user, layout, game, &target)?;
        }
        if let Some(observed_layout) = departing_layout.as_ref().or(target_layout.as_ref()) {
            let latest = (current_id == profile_id).then_some(&target);
            let owners = [Some(&departing), latest]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>();
            require_clean(&observe(observed_layout, &owners)?, "switching profiles")?;
        }
        if current_id == profile_id {
            if current_revision == target.revision {
                return Ok(target);
            }
            self.reconcile_selected(port_id, layout, &connection, &target)?;
            return Ok(target);
        }
        // Bring live data up to date from the launched build before parking it,
        // including supported edits from the game's mod menu.
        if selected_profile_uses_active_build(&connection, port_id)? {
            self.collect_active_user_data_if_launched(port_id)?;
        }
        self.reconcile_native_changes_locked(port_id, false)?;
        let (current_id, current_revision) = profile::selection(&connection, port_id)?
            .ok_or_else(|| PortcoveError::state("the port has no selected profile"))?;
        let departing = profile::revision_by_number(&connection, &current_id, current_revision)?;
        let paths = declared_state_paths(self, port_id)?;
        fs::create_dir_all(layout.store())?;
        write_journal(
            layout,
            &current_id,
            profile_id,
            target.revision,
            Phase::Start,
            &paths,
        )?;
        self.switch_steps(
            port_id,
            layout,
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
        if self.reconcile_selected_projection(port_id, layout, connection, current)? {
            self.sync_build_after_change(port_id, layout);
        }
        Ok(())
    }

    fn reconcile_selected_projection(
        &self,
        port_id: &str,
        layout: &Layout,
        connection: &rusqlite::Connection,
        current: &ProfileRevision,
    ) -> Result<bool> {
        let Some((id, revision)) = profile::selection(connection, port_id)? else {
            return Ok(false);
        };
        if id != current.profile_id || revision == current.revision {
            return Ok(false);
        }
        let materialized = profile::revision_by_number(connection, &id, revision)?;
        self.require_revision_loader(current)?;
        let target_layout = self.layout_for_revision(current)?;
        let materialized_layout = self.layout_for_revision(&materialized)?;
        let target = target_layout.as_ref().unwrap_or(layout);
        require_projectable(target, current)?;
        require_code_allowed(target, current)?;
        if let Some(observed_layout) = materialized_layout.as_ref().or(target_layout.as_ref()) {
            require_clean(
                &observe(observed_layout, &[&materialized, current])?,
                "finishing an interrupted change",
            )?;
        }
        mark_restore_pending(layout)?;
        if enabled(&materialized).next().is_some() || enabled(current).next().is_some() {
            deploy(target, Some(&materialized), current)?;
        }
        self.project_native_mod_list(current, Some(&materialized))?;
        profile::set_selection(connection, port_id, &id, current.revision)?;
        Ok(true)
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
            write_journal(layout, from, to, target.revision, phase, paths)?;
        }
        if phase == Phase::Parked {
            if enabled(departing).next().is_some() || enabled(target).next().is_some() {
                deploy(layout, Some(departing), target)?;
            }
            phase = Phase::Deployed;
            write_journal(layout, from, to, target.revision, phase, paths)?;
        }
        if phase == Phase::Deployed {
            move_paths(paths, &layout.parked(to), &layout.user)?;
        }
        // The arriving configuration is in place; make its list match the target.
        self.project_native_mod_list(target, None)?;
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
        if crate::profile_file_preservation::pending(layout)?.is_some() {
            let exact_layout = self.deploy_layout(port_id)?;
            self.recover_mod_file_locked(port_id, &exact_layout)?;
        }
        self.finish_interrupted_switch_locked(port_id, layout)?;
        // Keep supported native menu changes before an explicit setup action
        // rewrites the game's list.
        self.reconcile_native_changes_locked(port_id, false)
    }

    fn finish_interrupted_switch_locked(&self, port_id: &str, layout: &Layout) -> Result<()> {
        let journal = layout.journal();
        crate::path::refuse_symlink_ancestors(&journal)?;
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
            // Selection is the commit point. Only retire the receipt, even if a
            // former setup or runtime is no longer eligible for another switch.
            fs::remove_file(journal)?;
            return Ok(());
        }
        let target = profile::revision_by_number(&connection, &to, revision)?;
        if target.build.port_id != port_id {
            return Err(PortcoveError::verification(
                "profile switch target belongs to a different port",
            ));
        }
        let target_layout = self.layout_for_revision(&target)?;
        if selected != from {
            return Err(PortcoveError::conflict(
                "profile switch source is no longer selected",
            ));
        }
        let departing = profile::revision_by_number(&connection, &selected, selected_revision)?;
        let departing_layout = self.layout_for_revision(&departing)?;
        if departing_layout.is_none() && target_layout.is_none() {
            return Err(PortcoveError::unsupported(
                "neither setup has a reviewed mod loader",
            ));
        }
        if let Some(observed_layout) = departing_layout.as_ref().or(target_layout.as_ref()) {
            require_clean(
                &observe(observed_layout, &[&departing, &target])?,
                "resuming an interrupted profile switch",
            )?;
        }
        let target_layout = target_layout.as_ref().unwrap_or(layout);
        require_projectable(target_layout, &target)?;
        require_code_allowed(target_layout, &target)?;
        let paths = declared_state_paths(self, port_id)?;
        if let Some(recorded_paths) = value.get("paths") {
            if recorded_paths != &serde_json::to_value(&paths)? {
                return Err(PortcoveError::conflict(
                    "profile switch data paths changed since the switch began",
                ));
            }
        } else if phase != Phase::Start {
            // An older writer may have left newly recognized paths live when
            // it parked the departing profile. Their ownership is ambiguous.
            let old_paths = &self.catalog().port(port_id)?.persistent_paths;
            for path in paths.iter().filter(|path| !old_paths.contains(path)) {
                for root in [&layout.user, &layout.parked(&from), &layout.parked(&to)] {
                    let candidate = root.join(path);
                    crate::path::refuse_symlink_ancestors(&candidate)?;
                    if candidate.try_exists()? {
                        return Err(PortcoveError::conflict(
                            "an older profile switch left player data with unconfirmed ownership",
                        )
                        .detail("path", candidate.display().to_string()));
                    }
                }
            }
        }
        self.require_revision_loader(&target)?;
        self.switch_steps(
            port_id,
            target_layout,
            &from,
            &to,
            &paths,
            &departing,
            &target,
            phase,
        )
    }

    /// Reconcile the selected, materialized profile after reading the native
    /// list. An order change or a disable of a known enabled package is an
    /// exact change. An enabled entry for an absent package gives no authority
    /// to restore its bytes. The port lock must be held.
    pub(crate) fn reconcile_native_mod_list_locked(&self, port_id: &str) -> Result<()> {
        self.reconcile_native_changes_locked(port_id, true)
    }

    fn reconcile_native_changes_locked(&self, port_id: &str, capture_settings: bool) -> Result<()> {
        let Some(layout) = self.optional_deploy_layout(port_id)? else {
            return Ok(());
        };
        let Some(list) = layout.loader_list() else {
            return Ok(());
        };
        if layout.journal().try_exists()? {
            // Mid-switch, the live configuration may belong to the arriving profile.
            return Ok(());
        }
        let connection = self.library.connection()?;
        let Some((id, revision)) = profile::selection(&connection, port_id)? else {
            return Ok(());
        };
        let current = profile_current(&connection, port_id, &id)?;
        if current.revision != revision {
            // An interrupted change is finished from the revision, not the game.
            return Ok(());
        }
        let mut packages = current.packages.clone();
        let orderings = if let LiveList::Loads { names, .. } = read_live_list(&layout.user, list) {
            let names = filter_managed_names(names, &managed_names(&current));
            if names == native_projection(&current) {
                None
            } else {
                let Some(orderings) = adopted_order(&current, &names) else {
                    return Ok(());
                };
                let names = names.iter().map(String::as_str).collect::<BTreeSet<_>>();
                for package in packages.iter_mut().filter(|package| package.enabled) {
                    package.enabled =
                        names.contains(native_mod_list::native_name(&package.native_id));
                }
                Some(orderings)
            }
        } else {
            None
        };
        let settings = if let Some(game) = layout.recomp_game().filter(|_| capture_settings) {
            let captured =
                crate::recomp_mod_settings::capture(&layout.user, &layout, game, &current)?;
            (captured != current.settings).then_some(captured)
        } else {
            None
        };
        if orderings.is_none() && settings.is_none() {
            return Ok(());
        }
        let disabled = packages != current.packages;
        if disabled && !matches!(list, LoaderList::Recomp) {
            return Ok(());
        }
        if disabled {
            let mut candidate = current.clone();
            candidate.packages.clone_from(&packages);
            if let Some(orderings) = &orderings {
                candidate.orderings.clone_from(orderings);
            }
            // Leave an invalid native edit visible. Explicit setup actions can
            // still resolve it without first replaying it.
            if require_projectable(&layout, &candidate).is_err()
                || require_clean(
                    &observe(&layout, &[&current])?,
                    "recording native mod changes",
                )
                .is_err()
            {
                return Ok(());
            }
            mark_restore_pending(&layout)?;
        }
        let request = ProfileRevisionRequest {
            expected_revision: current.revision,
            packages: disabled.then_some(packages),
            orderings,
            settings,
            ..Default::default()
        };
        let next = self.create_profile_revision_locked(port_id, &id, &request)?;
        if disabled {
            deploy(&layout, Some(&current), &next)?;
            // The last game may have used a pinned runtime, so retain this
            // pending projection until the next launch restores its own build.
        }
        profile::set_selection(&connection, port_id, &id, next.revision)?;
        Ok(())
    }

    /// Writes the selected revision's enabled mods and order into the game's own
    /// list. An unreadable configuration is left untouched (and reported by
    /// `observe_live_mods`). Returns whether the canonical configuration changed.
    fn project_native_mod_list(
        &self,
        revision: &ProfileRevision,
        previous: Option<&ProfileRevision>,
    ) -> Result<bool> {
        let Some(layout) = self.layout_for_revision(revision)? else {
            return Ok(false);
        };
        // A same-setup transition can remove packages. Their old list entries
        // remain owned until this projection drops them. A cross-setup swap
        // restores the incoming setup's config and owns only its own entries.
        let mut managed = managed_names(revision);
        if let Some(previous) = previous {
            managed.extend(managed_names(previous));
        }
        match layout.loader_list() {
            None => Ok(false),
            Some(LoaderList::Ship(contract)) => {
                let names = match native_mod_list::read(&layout.user, &contract) {
                    NativeList::Unreadable(_) => return Ok(false),
                    NativeList::Listed(existing) => merged_list(&existing, revision, &managed),
                    NativeList::Absent | NativeList::Unlisted => native_projection(revision),
                };
                native_mod_list::write(&layout.user, &contract, &names)
            }
            Some(LoaderList::Recomp) => {
                use crate::recomp_mod_list::{self, RecompList};
                let wanted = native_projection(revision);
                let on = wanted.iter().cloned().collect::<BTreeSet<_>>();
                let observed = recomp_mod_list::read(&layout.user);
                let (enabled, order) = match &observed {
                    RecompList::Unreadable(_) => return Ok(false),
                    RecompList::Listed { enabled, order, .. } => {
                        recomp_mod_list::merged(enabled, order, &managed, &wanted, &on)
                    }
                    RecompList::Absent => (wanted.clone(), wanted),
                };
                if let Some(game) = layout.recomp_game() {
                    crate::recomp_mod_settings::project(&layout.user, &layout, game, revision)?;
                }
                recomp_mod_list::write(&layout.user, observed, &enabled, &order)
            }
        }
    }

    /// Before launch restores canonical data, reconcile supported native edits
    /// and project the exact selected revision. The port
    /// lock must be held.
    pub(crate) fn prepare_native_mod_list_locked(&self, port_id: &str) -> Result<()> {
        self.require_no_switch_journal(port_id)?;
        let Some(layout) = self.optional_deploy_layout(port_id)? else {
            crate::profile_file_preservation::require_idle(&self.library, port_id)?;
            return Ok(());
        };
        let Some(loader) = layout.loader_list() else {
            return Ok(());
        };
        self.recover_mod_file_locked(port_id, &layout)?;
        if layout.journal().try_exists()? {
            return Err(PortcoveError::state(
                "a profile switch was interrupted; finish it before playing",
            ));
        }
        let connection = self.library.connection()?;
        let Some((id, _)) = profile::selection(&connection, port_id)? else {
            return Ok(());
        };
        if matches!(loader, LoaderList::Recomp)
            && let LiveList::Unreadable(reason) = read_live_list(&layout.user, loader)
        {
            return Err(unreadable_recomp_list_hold(&reason));
        }
        let current = profile_current(&connection, port_id, &id)?;
        self.reconcile_selected_projection(port_id, &layout, &connection, &current)?;
        self.reconcile_native_mod_list_locked(port_id)?;
        let (_, revision) = profile::selection(&connection, port_id)?
            .ok_or_else(|| PortcoveError::state("the port has no selected profile"))?;
        let selected = profile::revision_by_number(&connection, &id, revision)?;
        require_projectable(&layout, &selected)?;
        require_exact_managed_packages(&layout.user, &layout, &selected, || {
            PortcoveError::conflict(
                "The mods folder does not match the selected setup. Review the mods in Setups and mods before playing.",
            )
            .with_known_cause(crate::failure::KnownFailureCause::NativeModListReview)
        })?;
        let effective = read_live_list(&layout.user, loader);
        let from_backup = matches!(
            &effective,
            LiveList::Loads {
                from_backup: true,
                ..
            }
        );
        let status = native_status_from_list(effective, &selected);
        if let NativeModListStatus::Unreadable { reason } = &status
            && matches!(loader, LoaderList::Recomp)
        {
            return Err(unreadable_recomp_list_hold(reason));
        }
        if let NativeModListStatus::Differs {
            missing,
            unexpected,
        } = &status
        {
            return Err(PortcoveError::conflict(
                "the game's mod list needs review. Check enabled mods and their dependencies in Setups and mods before playing.",
            )
            .detail("missing", missing.join(", "))
            .detail("unexpected", unexpected.join(", "))
            .with_known_cause(crate::failure::KnownFailureCause::NativeModListReview));
        }
        // Mark first: from here the canonical copy may be newer than the build's.
        mark_restore_pending(&layout)?;
        if from_backup
            && status == NativeModListStatus::InSync
            && let Some(game) = layout.recomp_game()
        {
            return crate::recomp_mod_settings::project(&layout.user, &layout, game, &selected);
        }
        self.project_native_mod_list(&selected, None)?;
        Ok(())
    }

    fn advance_and_deploy(
        &self,
        port_id: &str,
        profile_id: &str,
        layout: &Layout,
        request: &ProfileRevisionRequest,
        live: bool,
        synchronization: RuntimeSynchronization,
    ) -> Result<ProfileRevision> {
        let next = self.create_profile_revision_locked(port_id, profile_id, request)?;
        if live {
            self.library
                .connection()
                .and_then(|connection| match synchronization {
                    RuntimeSynchronization::Eager => {
                        self.reconcile_selected(port_id, layout, &connection, &next)
                    }
                    // The pending marker protects the canonical setup from
                    // the older runtime copy until launch synchronizes it.
                    RuntimeSynchronization::OnLaunch => self
                        .reconcile_selected_projection(port_id, layout, &connection, &next)
                        .map(|_| ()),
                })
                .map_err(|mut error| {
                    error.failure.mutation_state = crate::MutationState::Committed;
                    error
                        .detail("setup_revision", next.revision.to_string())
                        .detail("setup_revision_digest", &next.digest)
                })?;
        }
        Ok(next)
    }

    /// Refreshes the active build from canonical data and clears the pending mark
    /// only when that succeeded. Otherwise the mark keeps collection from copying
    /// the stale build over the profile until launch restores it.
    fn sync_build_after_change(&self, port_id: &str, layout: &Layout) {
        let can_refresh = self
            .library
            .connection()
            .and_then(|connection| selected_profile_uses_active_build(&connection, port_id))
            .is_ok_and(|uses_active| uses_active);
        if can_refresh && self.restore_active_user_data_if_launched(port_id) {
            let _ = clear_restore_pending(&layout.user);
        }
    }

    /// The build a launch should use. The default profile follows the active build,
    /// as a single-setup player expects. A selected non-default profile launches the
    /// exact build its materialized revision pins, for this launch only: the global
    /// active pointer never changes, and an unavailable pinned build holds the
    /// launch instead of substituting the latest one.
    pub(crate) fn profile_pinned_install(
        &self,
        port_id: &str,
        active: Option<crate::InstallRecord>,
    ) -> Result<Option<crate::InstallRecord>> {
        let Some(active) = active else {
            return Ok(None);
        };
        let connection = self.library.connection()?;
        let Some((profile_id, revision)) = profile::selection(&connection, port_id)? else {
            return Ok(Some(active));
        };
        let selected = profile::profile_by_id(&connection, port_id, &profile_id)?;
        if selected.is_default {
            return Ok(Some(active));
        }
        let pinned = profile::revision_by_number(&connection, &profile_id, revision)?.build;
        let unavailable = |reason: &str| {
            PortcoveError::conflict(
                "the selected profile's exact build cannot be launched; no other build was substituted",
            )
            .detail("profile", &selected.display_name)
            .detail("reason", reason)
        };
        let (install, verified) = if pinned.install_id == active.id {
            // The normal active launch checks its own executable. Read the
            // authenticated manifest here to check the rest of the exact pin.
            self.require_activation_gates(&active, None)
                .map_err(|error| error.detail("profile", &selected.display_name))?;
            let identity = crate::install::retained_build_identity_for_install(&active);
            (active, identity)
        } else {
            let install = crate::Library::install_by_id(&connection, Some(&pinned.install_id))?
                .ok_or_else(|| unavailable("the build is no longer installed"))?;
            let identity = self.verified_retained_build(port_id, &install.id);
            (install, identity)
        };
        let verified = verified.map_err(|error| {
            if error.code == crate::ErrorCode::Unsupported {
                error.detail("profile", &selected.display_name)
            } else {
                unavailable(&error.message)
            }
        })?;
        if pinned != verified {
            return Err(unavailable(
                "the build no longer matches the selected revision",
            ));
        }
        Ok(Some(install))
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
            pending_preservation: crate::profile_file_preservation::pending(&layout)?,
            native_list: native_status(&layout, &owner),
        })
    }
}

/// Everything a game-level mods view needs in one read: whether the game has a
/// reviewed mod contract, its setups and what is live now. Read-only.
/// Player intent for already installed packages. File identities and loader
/// facts always come from the current revision.
#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct ModSetupEdits {
    pub packages: Vec<ModSetupPackageEdit>,
    pub order: Option<Vec<String>>,
    #[serde(default)]
    pub local_files: Vec<LocalModDraftFile>,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct LocalModDraftFile {
    pub path: PathBuf,
    pub expected_plan_sha256: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct ModSetupPackageEdit {
    pub native_id: String,
    /// None queues removal. An explicit bool changes whether the mod is enabled.
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
pub struct ModSetupsView {
    pub port_id: String,
    /// False when the game has no reviewed mod package contract; nothing else is
    /// offered then.
    pub supported: bool,
    /// Package file types the game loads, such as `o2r`.
    pub package_types: Vec<String>,
    /// True when reviewed loader source shows that the later of two mods changing
    /// the same asset wins. False when the order is kept but which mod wins is not
    /// established.
    pub later_mods_take_priority: bool,
    /// None until the installed game has its default setup.
    pub inventory: Option<crate::ProfileInventory>,
    pub live: Option<LiveMods>,
    /// Unattended provider updates waiting for the player's review, for each
    /// setup's current revision.
    #[serde(default)]
    pub held_updates: Vec<crate::HeldModUpdate>,
    /// Results of the last automatic check, even after reopening the library.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub last_automatic_checks: Vec<crate::ProviderAutoUpdateCheck>,
    /// The mod provider this game has a reviewed binding for (`gamebanana` or
    /// `thunderstore`), if any.
    #[serde(default)]
    pub provider: Option<String>,
    /// Reviewed provider choices when the game offers more than one.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub providers: Vec<String>,
    /// Count from the materialized revision, including disabled mods.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applied_package_count: Option<usize>,
    /// The game's current installation. A setup whose build differs stays on
    /// its own build; an upgraded copy can use this one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_install_id: Option<String>,
    /// This game has a reviewed progress contract. Runtime and save contents
    /// are checked again during an explicit copy.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub progress_copy_supported: bool,
}

impl PortcoveService {
    pub fn mod_setups(&self, port_id: &str) -> Result<ModSetupsView> {
        self.mod_setups_with_inventory(port_id, |id| self.profile_inventory(id))
    }

    /// Desktop presentation checks runtime metadata, not immutable payload
    /// contents. The public inspection and CLI view keep full verification.
    pub fn preview_mod_setups(&self, port_id: &str) -> Result<ModSetupsView> {
        self.mod_setups_with_inventory(port_id, |id| self.preview_profile_inventory(id))
    }

    fn mod_setups_with_inventory(
        &self,
        port_id: &str,
        inventory: impl FnOnce(&str) -> Result<crate::ProfileInventory>,
    ) -> Result<ModSetupsView> {
        let port = self.catalog().port(port_id)?;
        let Some(layout) = self.optional_deploy_layout(port_id)? else {
            return Ok(ModSetupsView {
                port_id: port_id.into(),
                supported: false,
                package_types: Vec::new(),
                later_mods_take_priority: false,
                inventory: None,
                live: None,
                held_updates: Vec::new(),
                last_automatic_checks: Vec::new(),
                provider: None,
                providers: Vec::new(),
                applied_package_count: None,
                current_install_id: None,
                progress_copy_supported: false,
            });
        };
        // Reviews abandoned without Cancel (a closed window, a changed setup)
        // leave staging; reading the setups is a regular point to prune it.
        self.prune_staged(&layout.store().join("staged"));
        let inventory = inventory(port_id)?;
        let has_profiles = !inventory.profiles.is_empty();
        let held_updates = crate::provider_auto_update::held_updates(&layout, &inventory, port);
        let current_install_id = profile::active_install_id(&self.library.connection()?, port_id)?;
        let live = has_profiles
            .then(|| self.observe_live_mods(port_id))
            .transpose()?;
        let applied_package_count = live
            .as_ref()
            .and_then(|view| view.profile_id.as_deref().zip(view.revision))
            .map(|(id, revision)| {
                profile::revision_by_number(&self.library.connection()?, id, revision)
                    .map(|entry| entry.packages.len())
            })
            .transpose()?;
        Ok(ModSetupsView {
            held_updates,
            last_automatic_checks: crate::provider_auto_update::last_checks(&layout, &inventory),
            provider: crate::provider_binding::default_binding(port)
                .map(|binding| binding.provider().to_owned()),
            providers: crate::provider_binding::configured_bindings(port)
                .filter(|bindings| bindings.len() > 1)
                .map(|bindings| {
                    bindings
                        .iter()
                        .map(|binding| binding.provider().to_owned())
                        .collect()
                })
                .unwrap_or_default(),
            current_install_id,
            progress_copy_supported: crate::portable_saves::contract_for(port_id).is_some(),
            port_id: port_id.into(),
            supported: true,
            later_mods_take_priority: matches!(layout.loader_list(), Some(LoaderList::Ship(_))),
            package_types: layout
                .package_extensions()
                .iter()
                .map(|extension| (*extension).to_owned())
                .collect(),
            live,
            applied_package_count,
            inventory: has_profiles.then_some(inventory),
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
    /// An authorized file move waiting for recovery, even if the live name disappeared.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_preservation: Option<crate::ModFilePreservationPlan>,
    /// The game's own enabled-mods list compared with the selected revision.
    pub native_list: NativeModListStatus,
}

/// The canonical setup can belong to a retained runtime other than global active.
fn selected_profile_uses_active_build(
    connection: &rusqlite::Connection,
    port_id: &str,
) -> Result<bool> {
    let Some((id, revision)) = profile::selection(connection, port_id)? else {
        return Ok(true);
    };
    if profile::profile_by_id(connection, port_id, &id)?.is_default {
        return Ok(true);
    }
    let selected = profile::revision_by_number(connection, &id, revision)?;
    Ok(profile::active_install_id(connection, port_id)?.as_deref()
        == Some(selected.build.install_id.as_str()))
}

/// A change reviewed against `expected` still applies when the only newer
/// revision changed nothing but mod order (a reorder kept from the game's menu):
/// enabling, disabling or adding a package does not depend on order, and the
/// newer order is kept. Any other change since review needs a new review.
pub(crate) fn require_reviewed_or_reordered(
    connection: &rusqlite::Connection,
    current: &ProfileRevision,
    expected: u64,
) -> Result<()> {
    if current.revision == expected {
        return Ok(());
    }
    let order_only = current.parent_revision == Some(expected)
        && profile::revision_by_number(connection, &current.profile_id, expected).is_ok_and(
            |reviewed| {
                let comparable = |revision: &ProfileRevision| {
                    let mut copy = revision.clone();
                    copy.revision = 0;
                    copy.parent_revision = None;
                    copy.orderings.clear();
                    copy.created_at = 0;
                    copy.digest.clear();
                    copy
                };
                comparable(&reviewed) == comparable(current)
            },
        );
    if order_only {
        return Ok(());
    }
    Err(PortcoveError::conflict(
        "the profile changed after review; review its current revision again",
    ))
}

fn profile_current(
    connection: &rusqlite::Connection,
    port_id: &str,
    profile_id: &str,
) -> Result<ProfileRevision> {
    profile::current_revision(connection, port_id, profile_id)
}

/// Resolve the exact packages and load order for both preview and deployment.
pub(crate) fn proposed_mod_setup(
    layout: &Layout,
    current: &ProfileRevision,
    staged: &[StagedPackage],
    edits: Option<&ModSetupEdits>,
) -> Result<ProfileRevision> {
    if edits.is_some()
        && layout.loader_list().is_some()
        && let Some((first, second)) = native_mod_list::identity_collision(
            staged.iter().map(|item| item.inspection.file_name.as_str()),
        )
    {
        return Err(
            PortcoveError::conflict("two files in the draft have the same loader name")
                .detail("packages", format!("{first}, {second}")),
        );
    }
    for item in staged {
        validate_staged_mod(layout, &item.inspection)?;
    }
    let mut packages = current.packages.clone();
    if let Some(edits) = edits {
        let mut changed = BTreeSet::new();
        for edit in &edits.packages {
            if !changed.insert(&edit.native_id) {
                return Err(PortcoveError::usage(
                    "a draft changes a package more than once",
                ));
            }
            let Some(index) = packages
                .iter()
                .position(|item| item.native_id == edit.native_id)
            else {
                return Err(PortcoveError::conflict(
                    "a package in the draft is no longer installed",
                ));
            };
            if let Some(enabled) = edit.enabled {
                packages[index].enabled = enabled;
            } else {
                packages.remove(index);
            }
        }
    }
    let mut renames = Vec::<(String, String)>::new();
    for item in staged {
        let inspection = &item.inspection;
        let mut package = ResolvedPackage {
            native_id: inspection.file_name.clone(),
            native_version: item.native_version.clone(),
            provider: item.provider.clone(),
            provider_requires: item.provider_requires.clone(),
            sha256: inspection.sha256.clone(),
            size: inspection.size,
            enabled: true,
            requires: item.requires.clone(),
        };
        // Reinstalling the same native ID and bytes keeps its provider review.
        if package.provider.is_none()
            && let Some(installed) = current.packages.iter().find(|installed| {
                installed.provider.is_some()
                    && installed.native_id == package.native_id
                    && installed.sha256 == package.sha256
            })
        {
            package.provider.clone_from(&installed.provider);
            package
                .provider_requires
                .clone_from(&installed.provider_requires);
        }
        // A package the game loads as the same mod (for example `.otr` replaced
        // by `.o2r`) is replaced and keeps its place in the order.
        let named = layout.loader_list().is_some();
        let same_package = |existing: &&ResolvedPackage| {
            existing.native_id == package.native_id
                || (named && native_mod_list::same_mod(&existing.native_id, &package.native_id))
        };
        let replaced = packages
            .iter()
            .filter(same_package)
            .map(|existing| existing.native_id.clone())
            .collect::<Vec<_>>();
        package.enabled = packages
            .iter()
            .filter(same_package)
            .all(|existing| existing.enabled);
        for old in replaced.iter().filter(|old| **old != package.native_id) {
            renames.push((old.clone(), package.native_id.clone()));
        }
        packages.retain(|existing| !replaced.contains(&existing.native_id));
        packages.push(package);
    }
    packages.sort_by(|a, b| a.native_id.cmp(&b.native_id));
    if layout.loader_list().is_some()
        && let Some((first, second)) = native_mod_list::identity_collision(
            packages.iter().map(|package| package.native_id.as_str()),
        )
    {
        return Err(PortcoveError::conflict(
                "the game would treat these package files as the same mod; remove one before installing the other",
            )
            .detail("packages", format!("{first}, {second}")));
    }
    let mut existing_orderings = current.orderings.clone();
    if let Some(order) = edits.and_then(|edits| edits.order.as_ref()) {
        if layout.loader_list().is_none()
            || order.len() != current.packages.len()
            || order.iter().collect::<BTreeSet<_>>()
                != current
                    .packages
                    .iter()
                    .map(|package| &package.native_id)
                    .collect()
        {
            return Err(PortcoveError::conflict(
                "the reviewed load order must name every installed package once",
            ));
        }
        existing_orderings.retain(|ordering| ordering.domain != OVERRIDE_DOMAIN);
        existing_orderings.push(TypedOrdering {
            domain: OVERRIDE_DOMAIN.into(),
            native_ids: order.clone(),
        });
    }
    for ordering in &mut existing_orderings {
        for id in &mut ordering.native_ids {
            if let Some((_, new)) = renames.iter().find(|(old, _)| old == id) {
                id.clone_from(new);
            }
        }
        if edits.is_some() {
            ordering
                .native_ids
                .retain(|id| packages.iter().any(|package| package.native_id == *id));
        }
    }
    let orderings = with_override_order(&existing_orderings, &packages);
    let mut next = current.clone();
    next.packages = packages;
    next.orderings = orderings;
    if edits.is_some() {
        for package in &next.packages {
            let Some(origin) = package
                .provider
                .as_ref()
                .filter(|origin| origin.provider == crate::thunderstore::PROVIDER)
            else {
                continue;
            };
            let project = |member: &&StagedPackage| {
                member.provider.as_ref().is_some_and(|member| {
                    crate::provider_binding::same_project(&current.build.port_id, member, origin)
                })
            };
            let mut members = staged.iter().filter(project).peekable();
            if members.peek().is_some()
                && !members.any(|member| {
                    member.provider.as_ref() == Some(origin)
                        && member.inspection.file_name == package.native_id
                        && member.inspection.sha256 == package.sha256
                })
            {
                return Err(PortcoveError::conflict(
                    "the reviewed version drops an installed member; queue its removal too",
                )
                .detail("package", &package.native_id));
            }
        }
        profile::validate_revision(&next)?;
        require_projectable(&layout, &next)?;
    }
    Ok(next)
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
