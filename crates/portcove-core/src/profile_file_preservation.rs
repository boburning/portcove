//! Explicit preservation of a single regular file observed in the canonical mods root.
use std::{
    fs,
    io::{ErrorKind, Read},
    path::{Path, PathBuf},
};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    PortcoveError, PortcoveService, ProfileRevision, Result, profile, profile_deploy::Layout,
};

const JOURNAL_SIZE: u64 = 8192;
const MAX_IDENTICAL_PRESERVED_COPIES: u32 = 1024;
const MAX_FILE_SIZE: u64 = 16 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ModFileIdentity {
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ModFilePreservationPlan {
    pub plan_sha256: String,
    pub port_id: String,
    pub profile_id: String,
    pub revision: u64,
    pub revision_sha256: String,
    pub file_name: String,
    /// Distinguishes a rediscovered copy of the same bytes from prior preserved copies.
    pub slot: u32,
    pub observed: ModFileIdentity,
    /// For an edited managed file, the exact package that will be restored.
    pub restore: Option<ModFileIdentity>,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct ModFilePreservationResult {
    pub plan: ModFilePreservationPlan,
    /// Outside the loader's effective mod directories. The regular local package
    /// review may use this path, without granting execution or ownership here.
    pub preserved_path: PathBuf,
}

impl ModFilePreservationPlan {
    fn digest(&self) -> Result<String> {
        let mut unsealed = self.clone();
        unsealed.plan_sha256.clear();
        Ok(hex::encode(Sha256::digest(serde_json::to_vec(&(
            "portcove-mod-file-preservation-v1",
            unsealed,
        ))?)))
    }
}

impl PortcoveService {
    pub fn inspect_mod_file(
        &self,
        port_id: &str,
        file_name: &str,
    ) -> Result<ModFilePreservationPlan> {
        let _lock = self
            .library()
            .try_read_lock_port(port_id, "inspect-mod-file")?;
        let layout = self.deploy_layout(port_id)?;
        if let Some(plan) = pending(&layout)? {
            if plan.file_name == file_name {
                return Ok(plan);
            }
            return Err(pending_other(&plan));
        }
        self.require_completed_restore(port_id)?;
        let selected = selected(self, port_id, &layout)?;
        inspect(&layout, &selected, file_name)
    }

    pub fn preserve_mod_file(
        &self,
        port_id: &str,
        file_name: &str,
        approved_sha256: &str,
    ) -> Result<ModFilePreservationResult> {
        let _lock = self.library().try_lock_port(port_id, "preserve-mod-file")?;
        let layout = self.deploy_layout(port_id)?;
        let selected = selected(self, port_id, &layout)?;
        let plan = match pending(&layout)? {
            Some(plan) if plan.file_name == file_name && plan.plan_sha256 == approved_sha256 => {
                plan
            }
            Some(plan) => return Err(pending_other(&plan)),
            None => {
                self.require_completed_restore(port_id)?;
                let plan = inspect(&layout, &selected, file_name)?;
                if plan.plan_sha256 != approved_sha256 {
                    return Err(PortcoveError::conflict(
                        "the file or selected setup changed after review; inspect the file again",
                    ));
                }
                check_stored(&layout, &plan)?;
                let journal = journal(&layout);
                crate::path::refuse_symlink_ancestors(&journal)?;
                crate::profile_deploy::mark_restore_pending(&layout)?;
                crate::durability::write_bytes_atomically(
                    &journal,
                    &serde_json::to_vec(&plan)?,
                    false,
                )?;
                plan
            }
        };
        let preserved_path = finish(&layout, &selected, &plan)?;
        Ok(ModFilePreservationResult {
            plan,
            preserved_path,
        })
    }

    /// Completes an authorized move after interruption, before another projection
    /// can use the selected setup. Caller already holds the port operation lock.
    pub(crate) fn recover_mod_file_locked(&self, port_id: &str, layout: &Layout) -> Result<()> {
        if let Some(plan) = pending(layout)? {
            let selected = selected(self, port_id, layout)?;
            finish(layout, &selected, &plan)?;
        }
        Ok(())
    }
}

fn journal(layout: &Layout) -> PathBuf {
    layout.store().join("file-preservation.json")
}

pub(crate) fn pending(layout: &Layout) -> Result<Option<ModFilePreservationPlan>> {
    let path = journal(layout);
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
        Ok(_) => {}
    }
    crate::path::refuse_symlink_ancestors(&path)?;
    let plan: ModFilePreservationPlan =
        serde_json::from_slice(&crate::path::read_bounded_regular(&path, JOURNAL_SIZE)?)?;
    if plan.plan_sha256 != plan.digest()? {
        return Err(PortcoveError::verification(
            "the pending mod file preservation plan changed",
        ));
    }
    Ok(Some(plan))
}

pub(crate) fn require_idle(library: &crate::Library, port_id: &str) -> Result<()> {
    let layout = Layout::for_user(&library.user_dir(port_id));
    if let Some(plan) = pending(&layout)? {
        return Err(pending_other(&plan));
    }
    Ok(())
}

fn preserved_file(layout: &Layout, plan: &ModFilePreservationPlan) -> PathBuf {
    layout
        .store()
        .join("preserved")
        .join(&plan.plan_sha256)
        .join(&plan.file_name)
}

fn pending_other(plan: &ModFilePreservationPlan) -> PortcoveError {
    PortcoveError::conflict("finish the pending mod file preservation first")
        .detail("file_name", &plan.file_name)
        .detail("plan_sha256", &plan.plan_sha256)
}

fn selected(service: &PortcoveService, port_id: &str, layout: &Layout) -> Result<ProfileRevision> {
    if layout.journal().try_exists()? {
        return Err(PortcoveError::conflict(
            "finish the interrupted setup switch before preserving a mod file",
        ));
    }
    let connection = service.library().connection()?;
    let (profile_id, revision) = profile::selection(&connection, port_id)?
        .ok_or_else(|| PortcoveError::state("create a mod setup before preserving a mod file"))?;
    let selected = profile::current_revision(&connection, port_id, &profile_id)?;
    if selected.revision != revision {
        return Err(PortcoveError::conflict(
            "finish applying the selected setup before preserving a mod file",
        ));
    }
    Ok(selected)
}

fn require_exact_managed_name(revision: &ProfileRevision, file_name: &str) -> Result<()> {
    if let Some(package) = revision.packages.iter().find(|package| {
        package.enabled
            && package.native_id != file_name
            && package.native_id.eq_ignore_ascii_case(file_name)
    }) {
        return Err(PortcoveError::conflict(
            "this file uses different capitalization from the setup's recorded mod name. Close the game, rename the file to the recorded name in the mods folder, and review it again.",
        )
        .detail("recorded_name", &package.native_id));
    }
    Ok(())
}

fn expected(revision: &ProfileRevision, file_name: &str) -> Option<ModFileIdentity> {
    revision
        .packages
        .iter()
        .find(|package| package.enabled && package.native_id == file_name)
        .map(|package| ModFileIdentity {
            sha256: package.sha256.clone(),
            size: package.size,
        })
}

fn inspect(
    layout: &Layout,
    selected: &ProfileRevision,
    file_name: &str,
) -> Result<ModFilePreservationPlan> {
    require_exact_managed_name(selected, file_name)?;
    let live = crate::profile_deploy::live_package_path(layout, file_name)?;
    let root = layout.mods();
    crate::path::refuse_symlink_ancestors(&root)?;
    // Check the actual entry name, including case. A case-insensitive lookup
    // must not make a managed package appear unowned.
    let mut found = false;
    for entry in fs::read_dir(&root)? {
        if entry?.file_name() == file_name {
            found = true;
            break;
        }
    }
    if !found {
        return Err(PortcoveError::not_found(
            "the reviewed file is no longer in the mods folder",
        ));
    }
    let observed = identity(&live)?.ok_or_else(|| {
        PortcoveError::not_found("the reviewed file is no longer in the mods folder")
    })?;
    let restore = expected(selected, file_name);
    let runtime_marker =
        crate::profile_deploy::is_runtime_mod_marker(layout, file_name, observed.size);
    if restore.as_ref() == Some(&observed) || runtime_marker {
        return Err(PortcoveError::conflict(
            "the file still matches the setup or runtime that placed it",
        ));
    }
    let mut plan = ModFilePreservationPlan {
        plan_sha256: String::new(),
        port_id: layout.port_id(),
        profile_id: selected.profile_id.clone(),
        revision: selected.revision,
        revision_sha256: selected.digest.clone(),
        file_name: file_name.into(),
        slot: 0,
        observed,
        restore,
    };
    for slot in 0..MAX_IDENTICAL_PRESERVED_COPIES {
        plan.slot = slot;
        plan.plan_sha256 = plan.digest()?;
        let destination = preserved_file(layout, &plan);
        crate::path::refuse_symlink_ancestors(&destination)?;
        match fs::symlink_metadata(&destination) {
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(plan),
            Err(error) => return Err(error.into()),
            Ok(_) => {}
        }
    }
    Err(PortcoveError::conflict(
        "the preservation locations for this file are full; move earlier preserved copies to a folder outside the library before trying again",
    ))
}

fn identity(path: &Path) -> Result<Option<ModFileIdentity>> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if !metadata.is_file() || metadata.len() > MAX_FILE_SIZE {
        return Err(PortcoveError::conflict(
            "Portcove can preserve one regular mod file up to 16 GiB. To move this entry, close the game and review it in the mods folder.",
        )
        .detail("path", path.display().to_string()));
    }
    let file = crate::external_runtime::open_single_link_file(path)?;
    let size = file.metadata()?.len();
    let mut bytes = file.take(MAX_FILE_SIZE + 1);
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut read = 0u64;
    loop {
        let count = bytes.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
        read += count as u64;
    }
    if read != size || read > MAX_FILE_SIZE {
        return Err(PortcoveError::conflict(
            "the mod file changed during inspection",
        ));
    }
    Ok(Some(ModFileIdentity {
        sha256: hex::encode(hash.finalize()),
        size,
    }))
}

fn check_stored(layout: &Layout, plan: &ModFilePreservationPlan) -> Result<Option<PathBuf>> {
    let Some(restore) = &plan.restore else {
        return Ok(None);
    };
    let path = layout.package(&restore.sha256, &plan.file_name);
    if identity(&path)?.as_ref() != Some(restore) {
        return Err(PortcoveError::verification(
            "the recorded mod package is missing or changed in storage. Restore the exact package before preserving the edited file.",
        )
        .detail("sha256", &restore.sha256));
    }
    Ok(Some(path))
}

fn finish(
    layout: &Layout,
    selected: &ProfileRevision,
    plan: &ModFilePreservationPlan,
) -> Result<PathBuf> {
    if plan.port_id != layout.port_id()
        || plan.profile_id != selected.profile_id
        || plan.revision != selected.revision
        || plan.revision_sha256 != selected.digest
        || plan.restore != expected(selected, &plan.file_name)
        || plan.restore.as_ref() == Some(&plan.observed)
        || crate::profile_deploy::is_runtime_mod_marker(layout, &plan.file_name, plan.observed.size)
    {
        return Err(PortcoveError::conflict(
            "the pending mod file preservation belongs to a different setup state",
        ));
    }
    require_exact_managed_name(selected, &plan.file_name)?;
    let live = crate::profile_deploy::live_package_path(layout, &plan.file_name)?;
    let preserved = preserved_file(layout, plan);
    let directory = preserved.parent().ok_or_else(|| {
        PortcoveError::verification("the preserved mod file has no containing directory")
    })?;
    crate::path::refuse_symlink_ancestors(&live)?;
    crate::path::refuse_symlink_ancestors(&preserved)?;

    let mut live_identity = identity(&live)?;
    let mut preserved_identity = identity(&preserved)?;
    if preserved_identity.is_none() && live_identity.is_some() {
        if live_identity.as_ref() != Some(&plan.observed) {
            discard_journal(layout)?;
            return Err(PortcoveError::conflict(
                "the file changed before preservation; inspect it again",
            ));
        }
        check_stored(layout, plan)?;
        fs::create_dir_all(directory)?;
        // The destination entry and every newly created parent must survive
        // before renaming the only live copy into the preservation directory.
        let store = layout.store();
        crate::durability::sync_publication(&store.join("preserved"))?;
        for parent in store.ancestors().take(3) {
            crate::durability::sync_publication(parent)?;
        }
        crate::profile_deploy::mark_restore_pending(layout)?;
        crate::durability::rename_noreplace(&live, &preserved)?;
        crate::durability::sync_publication(directory)?;
        crate::durability::sync_publication(&layout.mods())?;
        live_identity = identity(&live)?;
        preserved_identity = identity(&preserved)?;
        if live_identity.is_none() && preserved_identity.as_ref() != Some(&plan.observed) {
            crate::durability::rename_noreplace(&preserved, &live)?;
            crate::durability::sync_publication(directory)?;
            crate::durability::sync_publication(&layout.mods())?;
            discard_journal(layout)?;
            return Err(PortcoveError::conflict(
                "the mod file changed as it was moved; it was returned to the mods folder",
            ));
        }
    }
    if preserved_identity.as_ref() != Some(&plan.observed)
        || (live_identity.is_some() && live_identity != plan.restore)
    {
        return Err(PortcoveError::conflict(
            "the mod file or preservation destination changed; review both locations before continuing",
        )
        .detail("mods_file", live.display().to_string())
        .detail("preserved_path", preserved.display().to_string()));
    }
    if live_identity.is_none()
        && let Some(stored) = check_stored(layout, plan)?
    {
        restore_missing(layout, &stored, &live, plan.restore.as_ref())?;
    }
    discard_journal(layout)?;
    Ok(preserved)
}

fn restore_missing(
    layout: &Layout,
    stored: &Path,
    live: &Path,
    expected: Option<&ModFileIdentity>,
) -> Result<()> {
    let tmp = layout.tmp();
    crate::path::refuse_symlink_ancestors(&tmp)?;
    fs::create_dir_all(&tmp)?;
    let mut staged = tempfile::NamedTempFile::new_in(tmp)?;
    let mut source =
        crate::external_runtime::open_single_link_file(stored)?.take(MAX_FILE_SIZE + 1);
    std::io::copy(&mut source, staged.as_file_mut())?;
    staged.as_file().sync_all()?;
    if identity(staged.path())?.as_ref() != expected {
        return Err(PortcoveError::verification(
            "the stored mod package changed during restoration",
        ));
    }
    crate::durability::rename_noreplace(staged.path(), live)?;
    crate::durability::sync_publication(&layout.mods())
}

fn discard_journal(layout: &Layout) -> Result<()> {
    fs::remove_file(journal(layout))?;
    crate::durability::sync_publication(&layout.store())
}
