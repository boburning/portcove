//! Freeze one whole-file default replacement for activation custody.
//! This preparation does not stage, publish or rename any file.

use super::{HeldSettingsCopies, transaction::custody, *};
use crate::game_settings::windows::HeldFile;
use crate::game_settings::{
    PlayerSettings, RetainedSettingsDefaults, SettingsFileUpdate, SettingsPreimage, SettingsUpdate,
    observe_player_settings_copy,
};
use crate::operation::game_settings::FileCustody;

pub(in crate::service) struct PreparedSettingsDefaultActivation {
    pub(in crate::service) previous: InstallRecord,
    pub(in crate::service) target: InstallRecord,
    pub(in crate::service) file_id: String,
    pub(in crate::service) relative_path: String,
    pub(in crate::service) maximum_bytes: u64,
    pub(in crate::service) files: HeldDefaultReplacement,
    pub(in crate::service) bytes: Vec<u8>,
}

pub(in crate::service) struct HeldDefaultReplacement {
    pub(in crate::service) canonical: FileCustody,
    pub(in crate::service) runtime: Option<FileCustody>,
    // The predecessor is a read-only witness, not one of the two write legs.
    _previous_runtime: Option<HeldFile>,
    _copies: HeldSettingsCopies,
}

fn hold(file: &GameSettingsFile, reason: &str) -> PortcoveError {
    PortcoveError::conflict(
        "the managed settings change needs review before this installation can be activated",
    )
    .detail("settings_file", &file.path)
    .detail("settings_reason", reason)
}

impl PortcoveService {
    /// Prepare after ordinary projection has established the target's copy and
    /// before the active pointer changes. The caller owns the port lock.
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
        let prior = installer.retained_settings_defaults(active)?;
        let incoming = installer.retained_settings_defaults(staged)?;
        let Some(incoming) = incoming else {
            if let Some(file) = prior.as_ref().and_then(first_shipped_file) {
                return Err(hold(file, "missing-incoming-default"));
            }
            return Ok(None);
        };
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

        let prior_contract = self.persistence_contract_for_install(active)?;
        let target_contract = self.persistence_contract_for_install(staged)?;
        let canonical_root = self.library.user_dir(&staged.port_id);
        let prior_root = (!prior_contract.writes_directly)
            .then(|| self.persistence_root(&prior_contract.port, &active.path))
            .transpose()?;
        let target_root = (!target_contract.writes_directly)
            .then(|| self.persistence_root(&target_contract.port, &staged.path))
            .transpose()?;
        let player = observe_player_settings_copy(&canonical_root, file)?;
        if let Some(root) = &prior_root
            && observe_player_settings_copy(root, file)? != player
        {
            return Err(hold(file, "divergent-player-settings-copies"));
        }
        let recorded = player
            .as_deref()
            .map_or(PlayerSettings::Unobserved, PlayerSettings::Present);
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
                    files,
                    bytes: bytes.clone(),
                }))
            }
            SettingsUpdate::KeepPlayerAndDefault(_) => {
                Err(hold(file, "player-and-default-diverged"))
            }
            SettingsUpdate::MissingBaseline { .. } => Err(hold(file, "missing-verified-default")),
            SettingsUpdate::MissingPlayerEvidence(_) => Err(hold(file, "missing-player-evidence")),
        }
    }
}

fn first_shipped_file(defaults: &RetainedSettingsDefaults) -> Option<&GameSettingsFile> {
    defaults
        .contract
        .files
        .iter()
        .find(|file| defaults.shipped.contains_key(&file.path))
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
    let runtime = target_root.map(|root| root.join(&file.path));
    let copies = HeldSettingsCopies::open(
        &canonical_root.join(&file.path),
        runtime.as_deref(),
        file.maximum_bytes,
    )?;
    if hex::encode(Sha256::digest(&copies.before)) != *sha256 {
        return Err(hold(file, "player-preimage-changed"));
    }
    let previous_runtime = prior_root
        .map(|root| {
            let mut held = HeldFile::open(&root.join(&file.path))?;
            if held.bytes(file.maximum_bytes)? != copies.before {
                return Err(hold(file, "previous-runtime-preimage-changed"));
            }
            Ok(held)
        })
        .transpose()?;
    let proposed_sha256 = hex::encode(Sha256::digest(bytes));
    let canonical = custody(&copies.canonical, sha256, &proposed_sha256);
    let runtime = copies
        .runtime
        .as_ref()
        .map(|held| custody(held, sha256, &proposed_sha256));
    Ok(HeldDefaultReplacement {
        canonical,
        runtime,
        _previous_runtime: previous_runtime,
        _copies: copies,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn freezes_owned_default_legs_and_detects_a_stale_runtime_mirror() {
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
        assert!(prepare().is_err());
        assert_eq!(fs::read(staged.join(&file.path)).unwrap(), incoming);
        assert_eq!(fs::read(canonical.join(&file.path)).unwrap(), old);
        fs::write(staged.join(&file.path), old).unwrap();
        fs::write(previous.join(&file.path), incoming).unwrap();
        assert!(prepare().is_err());
        assert_eq!(fs::read(previous.join(&file.path)).unwrap(), incoming);
        assert_eq!(fs::read(staged.join(&file.path)).unwrap(), old);
    }
}
