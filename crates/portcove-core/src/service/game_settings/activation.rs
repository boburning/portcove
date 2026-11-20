//! Freeze one whole-file default replacement for activation custody.
//! This preparation does not stage, publish or rename any file.

use super::super::backups::SnapshotOverlay;
use super::{
    HeldSettingsCopies, activation_deletion::PreparedSettingsDeletion, transaction::custody, *,
};
use crate::failure::KnownFailureCause;
use crate::game_settings::windows::{HeldAbsence, HeldFile};
use crate::game_settings::{
    PlayerSettings, RetainedSettingsDefaults, SettingsFileUpdate, SettingsPreimage, SettingsUpdate,
    observe_player_settings_copy,
};
use crate::operation::game_settings::{
    ActivationSettingsJournal, FileCustody, SettingsFileWitness,
};

pub(in crate::service) struct PreparedSettingsDefaultActivation {
    pub(in crate::service) previous: InstallRecord,
    pub(in crate::service) target: InstallRecord,
    pub(in crate::service) file_id: String,
    pub(in crate::service) relative_path: String,
    pub(in crate::service) maximum_bytes: u64,
    files: PreparedSettingsFiles,
}

enum PreparedSettingsFiles {
    Replace(Box<HeldDefaultReplacement>),
    Delete(Box<PreparedSettingsDeletion>),
}

pub(in crate::service) struct HeldDefaultReplacement {
    pub(in crate::service) canonical: FileCustody,
    pub(in crate::service) runtime: Option<FileCustody>,
    // The predecessor is a read-only witness, not one of the two write legs.
    previous_runtime: Option<HeldFile>,
    _copies: HeldSettingsCopies,
    runtime_projection_launch_id: Option<String>,
}

impl PreparedSettingsDefaultActivation {
    /// Snapshot the same player bytes held for projection. Only runtime-owned
    /// edits differ from the canonical file already copied by the backup.
    fn runtime_only_snapshot_bytes(&mut self) -> Result<Option<(String, Vec<u8>)>> {
        let PreparedSettingsFiles::Replace(files) = &mut self.files else {
            return Ok(None);
        };
        if files.runtime_projection_launch_id.is_none() {
            return Ok(None);
        }
        let changed =
            || PortcoveError::conflict("runtime settings changed before the update backup");
        let runtime = files.previous_runtime.as_mut().ok_or_else(changed)?;
        let bytes = runtime.bytes(self.maximum_bytes)?;
        if hex::encode(Sha256::digest(&bytes)) != files.canonical.proposed_sha256 {
            return Err(changed());
        }
        Ok(Some((files.canonical.previous_sha256.clone(), bytes)))
    }

    /// Bind custody before staging. The caller keeps these held originals
    /// through checked readback of the newly written lifecycle intent.
    pub(in crate::service) fn bind_journal(
        &self,
        operation: &mut LifecycleOperation,
    ) -> Result<()> {
        if operation.kind != LifecycleOperationKind::Activate
            || operation.phase != LifecyclePhase::Preparing
            || operation.settings_activation.is_some()
            || operation.port_id != self.target.port_id
            || !operation.install.as_ref().is_some_and(|target| {
                crate::recovery::same_activation_install(target, &self.target)
            })
        {
            return Err(PortcoveError::conflict(
                "settings custody does not match the pending staged activation",
            ));
        }
        let mut journal = ActivationSettingsJournal {
            format_version: 1,
            previous: self.previous.clone(),
            file_id: self.file_id.clone(),
            relative_path: self.relative_path.clone(),
            maximum_bytes: self.maximum_bytes,
            previous_runtime: None,
            canonical: None,
            runtime: None,
            deletion: None,
            runtime_projection_launch_id: None,
        };
        match &self.files {
            PreparedSettingsFiles::Replace(files) => {
                journal.previous_runtime =
                    files
                        .previous_runtime
                        .as_ref()
                        .map(|held| SettingsFileWitness {
                            path: held.path.clone(),
                            parent_identity: held.parent_identity.clone(),
                            original_identity: held.identity.clone(),
                        });
                journal.canonical = Some(files.canonical.clone());
                journal.runtime = files.runtime.clone();
                journal.runtime_projection_launch_id = files.runtime_projection_launch_id.clone();
            }
            PreparedSettingsFiles::Delete(files) => {
                files.confirm()?;
                journal.deletion = Some(files.journal.clone());
            }
        }
        operation.settings_activation = Some(journal);
        Ok(())
    }
}

fn hold(file: &GameSettingsFile, reason: &str) -> PortcoveError {
    PortcoveError::conflict(
        "the managed settings change needs review before this installation can be activated",
    )
    .detail("settings_file", &file.path)
    .detail("settings_reason", reason)
}

fn unverified_defaults(file: &GameSettingsFile, reason: &str) -> PortcoveError {
    hold(file, reason).with_known_cause(KnownFailureCause::SettingsDefaultsUnverified)
}

fn player_defaults_conflict(file: &GameSettingsFile) -> PortcoveError {
    hold(file, "player-and-default-diverged")
        .with_known_cause(KnownFailureCause::SettingsDefaultsConflict)
}

impl PortcoveService {
    pub(in crate::service) fn settings_update_requires_staging(
        &self,
        port: &PortDefinition,
        active: Option<&InstallRecord>,
    ) -> Result<bool> {
        let Some(active) = active else {
            return Ok(false);
        };
        if Platform::current()? != Platform::WindowsX86_64 {
            return Ok(false);
        }
        if port.game_settings.is_some() {
            return Ok(true);
        }
        if active.manifest_sha256.is_empty() {
            return Ok(false);
        }
        Ok(Installer::new(self.library.clone())?
            .retained_settings_defaults(active)?
            .is_some_and(|defaults| first_participating_file(&defaults).is_some()))
    }

    pub(in crate::service) fn publish_settings_default_activation_locked(
        &self,
        store: &OperationStore,
        mut operation: LifecycleOperation,
        kind: crate::VersionChangeKind,
        mut prepared: PreparedSettingsDefaultActivation,
    ) -> Result<InstallRecord> {
        let writer = store.settings_activation_writer()?.ok_or_else(|| {
            PortcoveError::unsupported(
                "managed settings activation requires its compatible library writer protocol",
            )
        })?;
        self.require_completed_backup_restore(&operation.port_id)?;
        self.require_completed_backup_deletion(&operation.port_id)?;
        let player_preimage = prepared.runtime_only_snapshot_bytes()?;
        let relative_path = prepared.relative_path.as_str();
        let maximum_bytes = prepared.maximum_bytes;
        let overlay = player_preimage.map(|(canonical_sha256, bytes)| {
            move |copy: &Path| {
                let path = copy.join(relative_path);
                crate::durability::write_bytes_atomically_checked(&path, &bytes, true, None, || {
                    let copied =
                        crate::external_runtime::read_single_link_metadata(&path, maximum_bytes)?;
                    if hex::encode(Sha256::digest(copied)) != canonical_sha256 {
                        return Err(PortcoveError::conflict(
                            "the private update backup has different canonical settings",
                        ));
                    }
                    Ok(())
                })
            }
        });
        let excluded = Some(relative_path);
        self.collect_active_user_data_except(&operation.port_id, excluded)?;
        self.snapshot_before_version_change(
            kind,
            &prepared.previous,
            Some(&prepared.previous.version),
            &prepared.target.version,
            false,
            overlay.as_ref().map(|apply| apply as &SnapshotOverlay<'_>),
        )?;
        self.prepare_retained_install_data_except(&prepared.target, excluded)?;
        self.carry_unknown_files(&prepared.previous, &prepared.target)?;
        let target = prepared.target.clone();
        prepared.bind_journal(&mut operation)?;
        writer.begin(&mut operation)?;
        drop(prepared);
        if let Err(error) = self.recover_checked_settings_activation(&writer, &mut operation) {
            let _ = writer.record_hold(&mut operation, &error.message);
            return Err(error);
        }
        self.library
            .status(&operation.port_id, target.channel)?
            .active
            .filter(|current| crate::recovery::same_activation_install(current, &target))
            .ok_or_else(|| {
                PortcoveError::state(
                    "settings activation committed without its exact active target",
                )
            })
    }

    /// Freeze the settings coordinate before ordinary data collection or
    /// projection can touch it. The caller owns the port lock.
    pub(in crate::service) fn prepare_settings_default_activation_locked(
        &self,
        active: &InstallRecord,
        staged: &InstallRecord,
    ) -> Result<Option<PreparedSettingsDefaultActivation>> {
        if Platform::current()? != Platform::WindowsX86_64 {
            return Ok(None);
        }
        self.managed_install_root(&active.port_id, &active.path)?;
        self.managed_install_root(&staged.port_id, &staged.path)?;
        let status = self.library.status(&staged.port_id, staged.channel)?;
        if active.port_id != staged.port_id
            || active.id == staged.id
            || active.path == staged.path
            || !status
                .active
                .as_ref()
                .is_some_and(|record| crate::recovery::same_activation_install(record, active))
            || !status
                .staged
                .as_ref()
                .is_some_and(|record| crate::recovery::same_activation_install(record, staged))
        {
            return Err(PortcoveError::conflict(
                "active or staged installation changed before the settings update could be prepared",
            ));
        }

        let installer = Installer::new(self.library.clone())?;
        let read_defaults = |install: &InstallRecord| {
            (!install.manifest_sha256.is_empty())
                .then(|| installer.retained_settings_defaults(install))
                .transpose()
                .map(Option::flatten)
        };
        let prior = read_defaults(active)?;
        let incoming = read_defaults(staged)?;
        let Some(incoming) = incoming else {
            if let Some(file) = prior.as_ref().and_then(first_participating_file) {
                return Err(unverified_defaults(file, "missing-incoming-default"));
            }
            return Ok(None);
        };
        for defaults in prior.iter().chain(std::iter::once(&incoming)) {
            for file in &defaults.contract.files {
                if let Some(reason) = defaults
                    .capture_gaps
                    .get(&file.path)
                    .and_then(|gap| gap.hold_reason())
                {
                    return Err(unverified_defaults(file, reason));
                }
            }
        }
        let files = incoming.contract.files.iter().filter(|file| {
            incoming.shipped.contains_key(&file.path)
                || prior.as_ref().is_some_and(|prior| {
                    prior.shipped.contains_key(&file.path)
                        && prior.contract.files.iter().any(|old| {
                            old.id == file.id && old.path == file.path && old.format == file.format
                        })
                })
        });
        let mut files = files.peekable();
        let Some(file) = files.next() else {
            return Ok(None);
        };
        if files.peek().is_some() {
            return Err(hold(file, "multiple-declared-settings-files"));
        }
        if !incoming.shipped.contains_key(&file.path)
            || !prior.as_ref().is_some_and(|prior| {
                prior.shipped.contains_key(&file.path)
                    && prior.contract.files.iter().any(|old| {
                        old.id == file.id && old.path == file.path && old.format == file.format
                    })
            })
        {
            return Err(unverified_defaults(file, "missing-verified-default"));
        }

        let prior_contract = self.persistence_contract_for_install(active)?;
        let target_contract = self.persistence_contract_for_install(staged)?;
        for port in [&prior_contract.port, &target_contract.port] {
            if port.runtime_data_policy.is_some()
                || crate::persistence::requires_restore_receipt(port)
                || !port.persistent_paths.contains(&file.path)
                || port
                    .persistent_paths
                    .iter()
                    .any(|path| file.path.starts_with(&format!("{path}/")))
            {
                return Err(hold(
                    file,
                    "settings-path-is-not-an-independent-persistent-file",
                ));
            }
        }
        let canonical_root = self.library.user_dir(&staged.port_id);
        let prior_root = (!prior_contract.writes_directly)
            .then(|| self.persistence_root(&prior_contract.port, &active.path))
            .transpose()?;
        let target_root = (!target_contract.writes_directly)
            .then(|| self.persistence_root(&target_contract.port, &staged.path))
            .transpose()?;
        let mut player = observe_player_settings_copy(&canonical_root, file)?;
        let mirrored = prior_root
            .as_deref()
            .map(|root| observe_player_settings_copy(root, file))
            .transpose()?;
        if let Some(runtime) = &mirrored
            && *runtime != player
        {
            let (Some(prior_root), Some(target_root), Some(runtime)) = (
                prior_root.as_deref(),
                target_root.as_deref(),
                runtime.as_deref(),
            ) else {
                return Err(hold(file, "divergent-player-settings-copies"));
            };
            if prior_contract.port.adapter != AdapterKind::NativePortable
                || target_contract.port.adapter != AdapterKind::NativePortable
            {
                return Err(hold(file, "divergent-player-settings-copies"));
            }
            let prior = prior
                .as_ref()
                .ok_or_else(|| unverified_defaults(file, "missing-verified-default"))?;
            let old_file = prior
                .contract
                .files
                .iter()
                .find(|old| old.id == file.id && old.path == file.path && old.format == file.format)
                .ok_or_else(|| unverified_defaults(file, "missing-verified-default"))?;
            let old = prior.shipped[&file.path].verified_bytes(old_file)?;
            let new = incoming.shipped[&file.path].verified_bytes(file)?;
            let last_launch = self
                .library
                .latest_finished_launch_session(&active.port_id)?;
            let marker = active.path.join(LAUNCH_MARKER);
            refuse_symlink_ancestors(&marker)?;
            if player.is_none()
                && status.previous.is_none()
                && last_launch.is_none()
                && !crate::profile_deploy::restore_pending(&canonical_root)
                && !marker.try_exists()?
                && runtime == old
                && observe_player_settings_copy(target_root, file)?.as_deref()
                    == Some(new.as_slice())
            {
                self.require_completed_backup_restore(&active.port_id)?;
                self.require_completed_backup_deletion(&active.port_id)?;
                seed_pristine_canonical_settings(
                    file,
                    [&canonical_root, prior_root, target_root],
                    [&old, &new],
                    &marker,
                )?;
                player = Some(old);
            } else {
                let Some(launch) =
                    last_launch.filter(|launch| verified_settings_launch(launch, active))
                else {
                    return Err(hold(file, "divergent-player-settings-copies"));
                };
                if !marker.is_file()
                    || crate::profile_deploy::restore_pending(&canonical_root)
                    || player.as_deref() != Some(old.as_slice())
                {
                    return Err(hold(file, "divergent-player-settings-copies"));
                }
                if old != new && runtime != new {
                    return Err(player_defaults_conflict(file));
                }
                let mut files = freeze_exact_replacement(
                    file,
                    [&canonical_root, prior_root, target_root],
                    &hex::encode(Sha256::digest(&old)),
                    runtime,
                    runtime,
                )?;
                files.runtime_projection_launch_id = Some(launch.id);
                return Ok(Some(PreparedSettingsDefaultActivation {
                    previous: active.clone(),
                    target: staged.clone(),
                    file_id: file.id.clone(),
                    relative_path: file.path.clone(),
                    maximum_bytes: file.maximum_bytes,
                    files: PreparedSettingsFiles::Replace(Box::new(files)),
                }));
            }
        }
        let Some(player) = player.as_deref() else {
            if prior_contract.port.adapter != AdapterKind::NativePortable
                || target_contract.port.adapter != AdapterKind::NativePortable
            {
                return Err(hold(file, "missing-player-evidence"));
            }
            let (Some(prior_root), Some(target_root)) =
                (prior_root.as_deref(), target_root.as_deref())
            else {
                return Err(hold(file, "missing-player-evidence"));
            };
            let prior = prior
                .as_ref()
                .ok_or_else(|| unverified_defaults(file, "missing-verified-default"))?;
            let old_file = prior
                .contract
                .files
                .iter()
                .find(|old| old.id == file.id && old.path == file.path && old.format == file.format)
                .ok_or_else(|| unverified_defaults(file, "missing-verified-default"))?;
            let old = prior.shipped[&file.path].verified_bytes(old_file)?;
            let new = incoming.shipped[&file.path].verified_bytes(file)?;
            let files = self.freeze_recorded_settings_deletion(
                active,
                old_file,
                file,
                [&canonical_root, prior_root, target_root],
                [&old, &new],
            )?;
            return Ok(Some(PreparedSettingsDefaultActivation {
                previous: active.clone(),
                target: staged.clone(),
                file_id: file.id.clone(),
                relative_path: file.path.clone(),
                maximum_bytes: file.maximum_bytes,
                files: PreparedSettingsFiles::Delete(Box::new(files)),
            }));
        };
        let recorded = PlayerSettings::Present(player);
        let plans = incoming.plan_update(
            prior.as_ref(),
            &std::collections::BTreeMap::from([(file.path.clone(), recorded)]),
        )?;
        let [plan] = plans.as_slice() else {
            return Err(hold(file, "unexpected-file-plan"));
        };

        match &plan.update {
            SettingsUpdate::KeepPlayer => Ok(None),
            SettingsUpdate::InstallDefault(bytes) => {
                let files = freeze_replacement(
                    file,
                    plan,
                    &canonical_root,
                    prior_root.as_deref(),
                    target_root.as_deref(),
                    bytes,
                )?;
                Ok(Some(PreparedSettingsDefaultActivation {
                    previous: active.clone(),
                    target: staged.clone(),
                    file_id: file.id.clone(),
                    relative_path: file.path.clone(),
                    maximum_bytes: file.maximum_bytes,
                    files: PreparedSettingsFiles::Replace(Box::new(files)),
                }))
            }
            SettingsUpdate::KeepPlayerAndDefault(_) => Err(player_defaults_conflict(file)),
            SettingsUpdate::MissingBaseline { .. } => {
                Err(unverified_defaults(file, "missing-verified-default"))
            }
            SettingsUpdate::MissingPlayerEvidence(_) => Err(hold(file, "missing-player-evidence")),
        }
    }
}

/// Start the canonical copy from the exact retained stock bytes. This can only
/// add a missing file. If staging stops, that complete stock copy is a valid
/// baseline for the next invocation of the normal settings writer.
fn seed_pristine_canonical_settings(
    file: &GameSettingsFile,
    roots: [&Path; 3],
    shipped: [&[u8]; 2],
    launch_marker: &Path,
) -> Result<()> {
    let mut previous = HeldFile::open(&roots[1].join(&file.path))?;
    let mut staged = HeldFile::open(&roots[2].join(&file.path))?;
    if previous.bytes(file.maximum_bytes)? != shipped[0]
        || staged.bytes(file.maximum_bytes)? != shipped[1]
    {
        return Err(hold(file, "fresh-settings-preimage-changed"));
    }
    let destination = roots[0].join(&file.path);
    let parent = destination
        .parent()
        .ok_or_else(|| hold(file, "missing-settings-parent"))?;
    refuse_symlink_ancestors(parent)?;
    fs::create_dir_all(parent)?;
    let absence = HeldAbsence::open(&destination)?;
    crate::durability::write_bytes_atomically_checked(&destination, shipped[0], false, None, || {
        refuse_symlink_ancestors(launch_marker)?;
        if launch_marker.try_exists()? {
            return Err(hold(file, "fresh-settings-preimage-changed"));
        }
        absence.confirm()
    })
}

pub(super) fn verified_settings_launch(
    launch: &LaunchSessionRecord,
    install: &InstallRecord,
) -> bool {
    launch.owner_kind == crate::LaunchOwnerKind::Managed
        && launch.port_id == install.port_id
        && launch.install_id == install.id
        && launch.install_root == install.path
        && launch.phase == crate::LaunchSessionPhase::Collecting
        && launch.outcome == Some(crate::LaunchSessionOutcome::Succeeded)
}

fn first_participating_file(defaults: &RetainedSettingsDefaults) -> Option<&GameSettingsFile> {
    defaults.contract.files.iter().find(|file| {
        defaults.shipped.contains_key(&file.path)
            || defaults
                .capture_gaps
                .get(&file.path)
                .and_then(|gap| gap.hold_reason())
                .is_some()
    })
}

fn freeze_replacement(
    file: &GameSettingsFile,
    plan: &SettingsFileUpdate,
    canonical_root: &Path,
    prior_root: Option<&Path>,
    target_root: Option<&Path>,
    bytes: &[u8],
) -> Result<HeldDefaultReplacement> {
    let SettingsPreimage::Present { sha256 } = &plan.player_preimage else {
        return Err(hold(file, "missing-player-evidence"));
    };
    plan.require_unchanged_player(file, canonical_root, prior_root)?;
    freeze_owned_settings_replacement(
        file,
        canonical_root,
        prior_root,
        target_root,
        sha256,
        None,
        bytes,
    )
}

fn freeze_exact_replacement(
    file: &GameSettingsFile,
    roots: [&Path; 3],
    previous_sha256: &str,
    previous_runtime: &[u8],
    proposed: &[u8],
) -> Result<HeldDefaultReplacement> {
    freeze_owned_settings_replacement(
        file,
        roots[0],
        Some(roots[1]),
        Some(roots[2]),
        previous_sha256,
        Some(previous_runtime),
        proposed,
    )
}

fn freeze_owned_settings_replacement(
    file: &GameSettingsFile,
    canonical_root: &Path,
    prior_root: Option<&Path>,
    target_root: Option<&Path>,
    sha256: &str,
    expected_runtime: Option<&[u8]>,
    bytes: &[u8],
) -> Result<HeldDefaultReplacement> {
    let mut copies =
        HeldSettingsCopies::open(&canonical_root.join(&file.path), None, file.maximum_bytes)?;
    if hex::encode(Sha256::digest(&copies.before)) != sha256 {
        return Err(hold(file, "player-preimage-changed"));
    }
    let previous_runtime = prior_root
        .map(|root| {
            let mut held = HeldFile::open(&root.join(&file.path))?;
            if held.bytes(file.maximum_bytes)? != expected_runtime.unwrap_or(&copies.before) {
                return Err(hold(file, "previous-runtime-preimage-changed"));
            }
            Ok(held)
        })
        .transpose()?;
    let proposed_sha256 = hex::encode(Sha256::digest(bytes));
    let canonical = custody(&copies.canonical, sha256, &proposed_sha256);
    let runtime = target_root
        .map(|root| {
            let mut held = HeldFile::open(&root.join(&file.path))?;
            held.require_editable_security()?;
            let target_bytes = held.bytes(file.maximum_bytes)?;
            if target_bytes != copies.before && target_bytes != bytes {
                return Err(hold(file, "staged-settings-preimage-changed"));
            }
            let leg = custody(
                &held,
                &hex::encode(Sha256::digest(&target_bytes)),
                &proposed_sha256,
            );
            copies.runtime = Some(held);
            Ok(leg)
        })
        .transpose()?;
    Ok(HeldDefaultReplacement {
        canonical,
        runtime,
        previous_runtime,
        _copies: copies,
        runtime_projection_launch_id: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn freezes_owned_default_legs_and_detects_a_stale_runtime_mirror() {
        let _integrity = crate::game_settings::windows::MediumIntegrityTest::enter();
        let temporary = tempfile::tempdir().unwrap();
        let catalog = Catalog::embedded().unwrap();
        let mut port = catalog.port("shipwright").unwrap().clone();
        let file = port.game_settings.as_ref().unwrap().files[0].clone();
        let old = br#"{"CVars":{"gSettings":{"Volume":{"Master":40}}}}"#;
        let incoming = br#"{"CVars":{"gSettings":{"Volume":{"Master":70}}}}"#;
        let mut capture = |version: &str, bytes: &[u8]| {
            let root = temporary.path().join(version);
            let path = root.join(&file.path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, bytes).unwrap();
            let descriptor = port.game_settings.as_mut().unwrap();
            descriptor.releases.truncate(1);
            let release = &mut descriptor.releases[0];
            release.version = version.into();
            release.archive_sha256 = hex::encode(Sha256::digest(version.as_bytes()));
            let digest = release.archive_sha256.clone();
            RetainedSettingsDefaults {
                contract: descriptor.clone(),
                shipped: crate::game_settings::capture_shipped_defaults(
                    &port,
                    Platform::WindowsX86_64,
                    version,
                    &digest,
                    &root,
                ),
                capture_gaps: Default::default(),
            }
        };
        let prior = capture("v1.0.0", old);
        let target = capture("v2.0.0", incoming);
        let plan = target
            .plan_update(
                Some(&prior),
                &std::collections::BTreeMap::from([(
                    file.path.clone(),
                    PlayerSettings::Present(old),
                )]),
            )
            .unwrap()
            .remove(0);
        assert_eq!(
            plan.update,
            SettingsUpdate::InstallDefault(incoming.to_vec())
        );

        let canonical = temporary.path().join("canonical");
        let previous = temporary.path().join("old-runtime");
        let staged = temporary.path().join("staged-runtime");
        for root in [&canonical, &previous, &staged] {
            let path = root.join(&file.path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, old).unwrap();
        }
        let prepare = || {
            freeze_replacement(
                &file,
                &plan,
                &canonical,
                Some(&previous),
                Some(&staged),
                incoming,
            )
        };
        let held = prepare().unwrap();
        let runtime = held.runtime.as_ref().unwrap();
        assert_eq!(held.canonical.path, canonical.join(&file.path));
        assert_eq!(runtime.path, staged.join(&file.path));
        assert_ne!(held.canonical.original_identity, runtime.original_identity);
        assert_eq!(held.canonical.previous_sha256, runtime.previous_sha256);
        assert_eq!(held.canonical.proposed_sha256, runtime.proposed_sha256);
        assert!(fs::write(previous.join(&file.path), incoming).is_err());
        drop(held);

        fs::write(staged.join(&file.path), incoming).unwrap();
        let pristine = prepare().unwrap();
        let pristine_runtime = pristine.runtime.as_ref().unwrap();
        assert_eq!(
            pristine_runtime.previous_sha256,
            pristine_runtime.proposed_sha256
        );
        drop(pristine);
        let foreign = b"concurrent staged bytes";
        fs::write(staged.join(&file.path), foreign).unwrap();
        assert!(prepare().is_err());
        assert_eq!(fs::read(staged.join(&file.path)).unwrap(), foreign);
        assert_eq!(fs::read(canonical.join(&file.path)).unwrap(), old);
        fs::write(staged.join(&file.path), old).unwrap();
        fs::write(previous.join(&file.path), incoming).unwrap();
        assert!(prepare().is_err());
        assert_eq!(fs::read(previous.join(&file.path)).unwrap(), incoming);
        assert_eq!(fs::read(staged.join(&file.path)).unwrap(), old);
    }
}

#[cfg(test)]
#[path = "activation_entrypoint_tests.rs"]
mod activation_entrypoint_tests;
