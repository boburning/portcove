//! Owned-file projection for the retained Daggerfall Unity loader.

use super::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RevisionKey {
    profile: String,
    revision: u64,
    digest: String,
}

impl From<&ProfileRevision> for RevisionKey {
    fn from(revision: &ProfileRevision) -> Self {
        Self {
            profile: revision.profile_id.clone(),
            revision: revision.revision,
            digest: revision.digest.clone(),
        }
    }
}

#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RuntimeProjection {
    applied: Option<RevisionKey>,
    pending: Option<RevisionKey>,
}

fn read_receipt(path: &Path) -> Result<RuntimeProjection> {
    crate::path::refuse_symlink_ancestors(path)?;
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(RuntimeProjection::default())
        }
        Err(error) => Err(error.into()),
        Ok(_) => Ok(serde_json::from_slice(&crate::path::read_bounded_regular(
            path,
            16 * 1024,
        )?)?),
    }
}

fn receipt_path(layout: &Layout, install: &crate::InstallRecord) -> Result<PathBuf> {
    if !profile::valid_native_id(&install.id)
        || crate::archive::validate_relative_path(&install.id, false).is_err()
    {
        return Err(PortcoveError::verification(
            "Daggerfall Unity retained build ID is invalid",
        ));
    }
    Ok(layout
        .store()
        .join("dfu-projection")
        .join(format!("{}.json", install.id)))
}

fn write_receipt(path: &Path, receipt: &RuntimeProjection) -> Result<()> {
    crate::path::refuse_symlink_ancestors(path)?;
    let parent = path.parent().ok_or_else(|| {
        PortcoveError::state("Daggerfall Unity projection has no receipt directory")
    })?;
    fs::create_dir_all(parent)?;
    crate::durability::write_json_atomically(path, receipt, path.try_exists()?)
}

fn receipt_revision(
    connection: &rusqlite::Connection,
    key: Option<&RevisionKey>,
    install: &crate::InstallRecord,
) -> Result<Option<ProfileRevision>> {
    key.map(|key| {
        let revision = profile::revision_by_number(connection, &key.profile, key.revision)?;
        if revision.digest != key.digest
            || !revision.build.matches_install(install)
            || revision.loader
                != Some(crate::profile_loader::ModEngine::DaggerfallUnity.reference())
        {
            return Err(PortcoveError::verification(
                "Daggerfall Unity projection receipt does not match the retained build",
            ));
        }
        Ok(revision)
    })
    .transpose()
}

fn portable_marker(path: &Path) -> Result<bool> {
    crate::path::refuse_symlink_ancestors(path)?;
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && metadata.len() == 0 => Ok(true),
        Ok(_) => Err(PortcoveError::verification(
            "Daggerfall Unity Portable.txt must be an empty regular file",
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

pub(super) fn store_reviewed_package(
    layout: &Layout,
    source: &Path,
    inspection: &crate::ModPackageInspection,
) -> Result<()> {
    use sha2::{Digest, Sha256};
    let destination = layout.package(&inspection.sha256, &inspection.file_name);
    crate::path::refuse_symlink_ancestors(&destination)?;
    let expected = &inspection.sha256;
    if destination.try_exists()? {
        if crate::external_runtime::hash_stable_regular(&destination, inspection.size, &|| Ok(()))
            .is_ok_and(|(sha256, size)| &sha256 == expected && size == inspection.size)
        {
            return Ok(());
        }
        return Err(PortcoveError::verification(
            "stored Daggerfall Unity package was modified",
        ));
    }
    let bytes =
        crate::external_runtime::read_single_link_metadata(source, crate::dfu_mod::MAX_BYTES)?;
    if bytes.len() as u64 != inspection.size || &hex::encode(Sha256::digest(&bytes)) != expected {
        return Err(PortcoveError::verification(
            "Daggerfall Unity mod changed after review",
        ));
    }
    let parent = destination
        .parent()
        .ok_or_else(|| PortcoveError::state("mod storage has no parent"))?;
    fs::create_dir_all(parent)?;
    crate::durability::write_bytes_atomically_checked(&destination, &bytes, false, None, || {
        crate::path::refuse_symlink_ancestors(&destination)
    })
}

pub(super) fn deploy_owned_files(
    layout: &Layout,
    from: Option<&ProfileRevision>,
    to: &ProfileRevision,
) -> Result<()> {
    let owners = from
        .into_iter()
        .chain(std::iter::once(to))
        .collect::<Vec<_>>();
    require_clean(
        &observe(layout, &owners)?,
        "changing owned Daggerfall Unity files",
    )?;
    let previous = from.into_iter().flat_map(enabled).collect::<Vec<_>>();
    let desired = enabled(to).collect::<Vec<_>>();
    let current_matches = |path: &Path, file: &ResolvedPackage| {
        crate::external_runtime::hash_stable_regular(path, file.size, &|| Ok(()))
            .is_ok_and(|(digest, size)| digest == file.sha256 && size == file.size)
    };
    let changed =
        || PortcoveError::conflict("Daggerfall Unity mod files changed during publication");
    // Revalidate each exact path before mutation, and use create-new for absent
    // destinations. Unmanaged siblings and recursive subdirectories stay put.
    for file in desired.iter().copied() {
        let live = live_package_path(layout, &file.native_id)?;
        crate::path::refuse_symlink_ancestors(&live)?;
        if current_matches(&live, file) {
            continue;
        }
        let old = previous.iter().find(|old| old.native_id == file.native_id);
        let replacing = live.try_exists()?;
        if replacing && !old.is_some_and(|old| current_matches(&live, old)) {
            return Err(changed());
        }
        let source = layout.package(&file.sha256, &file.native_id);
        let bytes =
            crate::external_runtime::read_single_link_metadata(&source, crate::dfu_mod::MAX_BYTES)?;
        if bytes.len() as u64 != file.size || !current_matches(&source, file) {
            return Err(changed());
        }
        use sha2::{Digest, Sha256};
        if hex::encode(Sha256::digest(&bytes)) != file.sha256 {
            return Err(changed());
        }
        let mods = layout.mods();
        let parent = mods
            .parent()
            .ok_or_else(|| PortcoveError::state("Daggerfall Unity Mods has no parent"))?;
        fs::create_dir_all(&mods)?;
        crate::path::refuse_symlink_ancestors(parent)?;
        // A crash may strand this operation-private folder, which is outside
        // Unity's recursive Mods scan. Publication is rename-only: a mount
        // boundary fails closed without a copy into Mods.
        let staging = tempfile::Builder::new()
            .prefix(".portcove-dfu-")
            .tempdir_in(parent)?;
        let staged = staging.path().join(&file.native_id);
        let mut handle = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&staged)?;
        handle.write_all(&bytes)?;
        handle.sync_all()?;
        drop(handle);
        crate::path::refuse_symlink_ancestors(&live)?;
        if replacing {
            if !old.is_some_and(|old| current_matches(&live, old)) {
                return Err(changed());
            }
            fs::rename(&staged, &live)?;
        } else {
            crate::durability::rename_noreplace(&staged, &live)?;
        }
        crate::durability::sync_publication(&mods)?;
    }
    for file in previous.iter().copied() {
        if desired
            .iter()
            .any(|wanted| wanted.native_id == file.native_id)
        {
            continue;
        }
        let live = live_package_path(layout, &file.native_id)?;
        crate::path::refuse_symlink_ancestors(&live)?;
        if live.try_exists()? {
            if !current_matches(&live, file) {
                return Err(changed());
            }
            fs::remove_file(live)?;
            crate::durability::sync_publication(&layout.mods())?;
        }
    }
    Ok(())
}

#[cfg(test)]
pub(super) fn record_test_pending(
    layout: &Layout,
    install: &crate::InstallRecord,
    from: &ProfileRevision,
    to: &ProfileRevision,
) -> Result<()> {
    write_receipt(
        &receipt_path(layout, install)?,
        &RuntimeProjection {
            applied: Some(from.into()),
            pending: Some(to.into()),
        },
    )
}

fn observed_save_group(path: &Path) -> Result<Option<crate::AdoptionCopyPlan>> {
    crate::path::refuse_symlink_ancestors(path)?;
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
        Ok(_) => crate::library_transfer::reviewed_tree(path).map(Some),
    }
}

fn save_group_drift() -> PortcoveError {
    PortcoveError::conflict(
        "Daggerfall Unity runtime progress differs from the selected setup; preserve it and review the save group",
    )
}

impl PortcoveService {
    /// The extra runtime root is derived from the retained executable contract;
    /// it is never taken from the archive, a caller path or the profile JSON.
    fn dfu_save_root(&self, revision: &ProfileRevision) -> Result<PathBuf> {
        let connection = self.library.connection()?;
        let install = crate::Library::install_by_id(&connection, Some(&revision.build.install_id))?
            .filter(|install| revision.build.matches_install(install))
            .ok_or_else(|| {
                PortcoveError::conflict("Daggerfall Unity runtime changed before save preparation")
            })?;
        crate::output_root::validate_install_path(&self.library, &install.port_id, &install.path)
    }

    pub(super) fn preflight_dfu_save_switch(
        &self,
        layout: &Layout,
        departing: &ProfileRevision,
        target: &ProfileRevision,
    ) -> Result<()> {
        if layout.dfu_platform.is_none() || departing.save_group == target.save_group {
            return Ok(());
        }
        let runtime = self.dfu_save_root(departing)?.join("PortableAppdata");
        if let Some(live) = observed_save_group(&runtime)?
            && Some(live) != observed_save_group(&layout.user.join("PortableAppdata"))?
        {
            return Err(save_group_drift());
        }
        Ok(())
    }

    pub(super) fn restore_dfu_save_group(
        &self,
        layout: &Layout,
        departing: &ProfileRevision,
        target: &ProfileRevision,
    ) -> Result<()> {
        if layout.dfu_platform.is_none() || departing.save_group == target.save_group {
            return Ok(());
        }
        if departing.build != target.build {
            return Err(PortcoveError::unsupported(
                "Daggerfall Unity save-group switches require the same exact managed runtime",
            ));
        }
        let root = self.dfu_save_root(target)?;
        let active = root.join("PortableAppdata");
        let previous = layout.parked(&departing.profile_id).join("PortableAppdata");
        let arriving = layout.user.join("PortableAppdata");
        let next = observed_save_group(&arriving)?;
        let live = observed_save_group(&active)?;
        if live == next {
            return Ok(());
        }
        let old = observed_save_group(&previous)?;
        if live.is_some() && live != old {
            return Err(save_group_drift());
        }
        let staging = tempfile::Builder::new()
            .prefix(".portcove-dfu-saves-")
            .tempdir_in(&root)?;
        let staged = staging.path().join("arriving");
        if next.is_some() {
            crate::service::copy_tree(&arriving, &staged)?;
            if observed_save_group(&staged)? != next || observed_save_group(&arriving)? != next {
                return Err(save_group_drift());
            }
        }
        if observed_save_group(&active)? != live || observed_save_group(&previous)? != old {
            return Err(save_group_drift());
        }
        if live.is_some() {
            crate::durability::rename_noreplace(&active, &staging.path().join("departing"))?;
            crate::durability::sync_publication(&root)?;
        }
        if next.is_some() {
            crate::durability::rename_noreplace(&staged, &active)?;
            crate::durability::sync_publication(&root)?;
        }
        if observed_save_group(&active)? != next {
            return Err(save_group_drift());
        }
        Ok(())
    }

    pub(crate) fn dfu_restore_projection(
        &self,
        install: &crate::InstallRecord,
        runtime_root: &Path,
    ) -> Result<()> {
        let connection = self.library.connection()?;
        let Some((profile_id, number)) = profile::selection(&connection, &install.port_id)? else {
            return Ok(());
        };
        let next = profile::revision_by_number(&connection, &profile_id, number)?;
        let expected_loader = crate::profile_loader::ModEngine::DaggerfallUnity.reference();
        if next.loader.as_ref() != Some(&expected_loader) {
            return Ok(());
        }
        // Restoring data to a different retained build cannot activate mods for it.
        if !next.build.matches_install(install) {
            return Ok(());
        }
        let Some(layout) = self.layout_for_install(install)? else {
            return Err(PortcoveError::unsupported(
                "Daggerfall Unity loader is unavailable for the retained build",
            ));
        };
        let owned_root = crate::output_root::validate_install_path(
            &self.library,
            &install.port_id,
            &install.path,
        )?;
        crate::path::refuse_symlink_ancestors(runtime_root)?;
        if owned_root != fs::canonicalize(runtime_root)? {
            return Err(PortcoveError::verification(
                "Daggerfall Unity runtime mod root differs from its retained build",
            ));
        }
        let runtime = Layout {
            user: runtime_root.to_path_buf(),
            ..layout
        };
        let canonical = self.require_layout_for_revision(&next)?;
        if !portable_marker(&runtime.user.join("Portable.txt"))?
            && !portable_marker(&canonical.user.join("Portable.txt"))?
        {
            return Err(PortcoveError::unsupported(
                "Daggerfall Unity local mod profiles require the reviewed Portable.txt mode",
            ));
        }
        require_exact_managed_packages(&canonical.user, &canonical, &next, || {
            PortcoveError::conflict(
                "Daggerfall Unity canonical mods do not match the selected setup",
            )
        })?;
        let receipt_path = receipt_path(&runtime, install)?;
        let mut receipt = read_receipt(&receipt_path)?;
        let applied = receipt_revision(&connection, receipt.applied.as_ref(), install)?;
        let pending = receipt_revision(&connection, receipt.pending.as_ref(), install)?;
        let owners = applied.iter().chain(pending.iter()).collect::<Vec<_>>();
        require_clean(
            &observe(&runtime, &owners)?,
            "projecting Daggerfall Unity mods",
        )?;
        let next_key = RevisionKey::from(&next);
        if let Some(pending) = pending.as_ref() {
            deploy(&runtime, applied.as_ref(), pending)?;
            receipt.applied = receipt.pending.take();
            write_receipt(&receipt_path, &receipt)?;
        }
        if receipt.applied.as_ref() == Some(&next_key) {
            return require_exact_managed_packages(&runtime.user, &runtime, &next, || {
                PortcoveError::conflict(
                    "Daggerfall Unity runtime mods do not match the recorded setup",
                )
            });
        }
        let from = pending.as_ref().or(applied.as_ref());
        require_code_allowed(&runtime, &next)?;
        receipt.pending = Some(next_key);
        write_receipt(&receipt_path, &receipt)?;
        deploy(&runtime, from, &next)?;
        require_exact_managed_packages(&runtime.user, &runtime, &next, || {
            PortcoveError::conflict("Daggerfall Unity runtime mods changed during projection")
        })?;
        receipt.applied = receipt.pending.take();
        write_receipt(&receipt_path, &receipt)
    }

    pub(super) fn require_dfu_target_clean(
        &self,
        layout: &Layout,
        revision: &ProfileRevision,
    ) -> Result<()> {
        if layout.dfu_platform.is_none() {
            return Ok(());
        }
        let connection = self.library.connection()?;
        let install = crate::Library::install_by_id(&connection, Some(&revision.build.install_id))?
            .filter(|install| revision.build.matches_install(install))
            .ok_or_else(|| {
                PortcoveError::conflict("Daggerfall Unity runtime changed after review")
            })?;
        let runtime = Layout {
            user: crate::output_root::validate_install_path(
                &self.library,
                &install.port_id,
                &install.path,
            )?,
            store: layout.store.clone(),
            loader: layout.loader.clone(),
            dfu_platform: layout.dfu_platform,
        };
        if !portable_marker(&runtime.user.join("Portable.txt"))?
            && !portable_marker(&layout.user.join("Portable.txt"))?
        {
            return Err(PortcoveError::unsupported(
                "Daggerfall Unity local mod profiles require the reviewed Portable.txt mode",
            ));
        }
        let receipt = read_receipt(&receipt_path(&runtime, &install)?)?;
        let applied = receipt_revision(&connection, receipt.applied.as_ref(), &install)?;
        let pending = receipt_revision(&connection, receipt.pending.as_ref(), &install)?;
        let owners = applied.iter().chain(pending.iter()).collect::<Vec<_>>();
        require_clean(
            &observe(&runtime, &owners)?,
            "reviewing Daggerfall Unity mods",
        )
    }

    pub(crate) fn require_dfu_runtime_ownership(
        &self,
        port_id: &str,
        install: Option<&crate::InstallRecord>,
        runtime_root: &Path,
    ) -> Result<()> {
        crate::path::refuse_symlink_ancestors(runtime_root)?;
        let platform = crate::Platform::current()?;
        let mut layout = Layout::for_user(&self.library.user_dir(port_id));
        layout.user = runtime_root.to_path_buf();
        layout.dfu_platform = Some(platform);
        let connection = self.library.connection()?;
        let receipt = match install {
            Some(install) => read_receipt(&receipt_path(&layout, install)?)?,
            None => RuntimeProjection::default(),
        };
        let Some(install) =
            install.filter(|_| receipt.applied.is_some() || receipt.pending.is_some())
        else {
            return require_clean(
                &observe(&layout, &[])?,
                "checking unclaimed Daggerfall Unity runtime files",
            );
        };
        if self.layout_for_install(install)?.is_none() {
            return Err(PortcoveError::verification(
                "Daggerfall Unity receipt lost its retained loader",
            ));
        }
        let applied = receipt_revision(&connection, receipt.applied.as_ref(), install)?;
        let pending = receipt_revision(&connection, receipt.pending.as_ref(), install)?;
        let owners = applied.iter().chain(pending.iter()).collect::<Vec<_>>();
        require_clean(
            &observe(&layout, &owners)?,
            "checking Daggerfall Unity runtime ownership",
        )?;
        if let Some(applied) = applied.as_ref().filter(|_| pending.is_none()) {
            require_exact_managed_packages(runtime_root, &layout, applied, || {
                PortcoveError::conflict(
                    "Daggerfall Unity runtime mods require recovery before player data can be collected",
                )
            })?;
        }
        Ok(())
    }

    pub(crate) fn dfu_projection_selected(&self, port_id: &str) -> Result<bool> {
        let projection_dir = Layout::for_user(&self.library.user_dir(port_id))
            .store()
            .join("dfu-projection");
        crate::path::refuse_symlink_ancestors(&projection_dir)?;
        if projection_dir.try_exists()? {
            return Ok(true);
        }
        let connection = self.library.connection()?;
        let Some((profile_id, _)) = profile::selection(&connection, port_id)? else {
            return Ok(false);
        };
        let latest = profile_current(&connection, port_id, &profile_id)?;
        // Merely creating an empty default profile does not take ownership
        // of the existing game's ordinary manual mod and data handling.
        Ok(
            latest.loader == Some(crate::profile_loader::ModEngine::DaggerfallUnity.reference())
                && !latest.packages.is_empty(),
        )
    }
}
