//! Activate a staged NativePortable successor while preserving a reviewed
//! settings deletion. Only the successor's verified shipped copy is writable.
use super::transaction::{checkpoint, hash};
use super::*;
use crate::game_settings::windows::{HeldAbsence, HeldFile};
use crate::operation::{
    SettingsFaultPoint,
    game_settings::{
        ActivationSettingsDeletion, SettingsAbsenceWitness, SettingsActivationJournal,
        SettingsActivationPointer, SettingsActivationWriter, SettingsFileWitness,
        activation_pointer, owned_names,
    },
};

pub(super) struct PreparedSettingsDeletion {
    pub(super) journal: ActivationSettingsDeletion,
    canonical: HeldAbsence,
    previous_runtime: HeldAbsence,
    _incoming: HeldFile,
}

impl PreparedSettingsDeletion {
    pub(super) fn confirm(&self) -> Result<()> {
        self.canonical.confirm()?;
        self.previous_runtime.confirm()
    }
}

impl PortcoveService {
    pub(super) fn freeze_recorded_settings_deletion(
        &self,
        previous: &InstallRecord,
        old_file: &GameSettingsFile,
        new_file: &GameSettingsFile,
        roots: [&Path; 3],
        shipped: [&[u8]; 2],
    ) -> Result<PreparedSettingsDeletion> {
        let canonical = HeldAbsence::open(&roots[0].join(&old_file.path))?;
        let previous_runtime = HeldAbsence::open(&roots[1].join(&old_file.path))?;
        let restore_id = self
            .recorded_settings_restore_deletion(
                previous,
                old_file,
                &hash(shipped[0]),
                [&canonical, &previous_runtime],
                None,
            )?
            .ok_or_else(|| held().detail("settings_reason", "missing-player-evidence"))?;
        let mut incoming = HeldFile::open(&roots[2].join(&new_file.path))?;
        incoming.require_editable_security()?;
        if incoming.bytes(new_file.maximum_bytes)? != shipped[1] {
            return Err(held().detail("settings_reason", "incoming-default-changed"));
        }
        Ok(PreparedSettingsDeletion {
            journal: ActivationSettingsDeletion {
                restore_id,
                canonical: absence_witness(&canonical),
                previous_runtime: absence_witness(&previous_runtime),
                incoming: SettingsFileWitness {
                    path: incoming.path.clone(),
                    parent_identity: incoming.parent_identity.clone(),
                    original_identity: incoming.identity.clone(),
                },
            },
            canonical,
            previous_runtime,
            _incoming: incoming,
        })
    }

    pub(super) fn recover_recorded_settings_deletion(
        &self,
        writer: &SettingsActivationWriter<'_>,
        operation: &mut LifecycleOperation,
    ) -> Result<()> {
        for _ in 0..5 {
            writer.confirm(operation)?;
            crate::operation::game_settings::validate_journal(&self.library, operation)?;
            let target = operation.install.clone().ok_or_else(held)?;
            let journal = operation.settings_activation.clone().ok_or_else(held)?;
            let deletion = journal.deletion.as_ref().ok_or_else(held)?;
            let status = self.library.status(&operation.port_id, target.channel)?;
            let pointer = activation_pointer(operation, &status)?;
            if pointer == SettingsActivationPointer::PreviousActive {
                self.require_activation_gates(&target, None)?;
            }
            let evidence = self.verify_recorded_settings_deletion(&journal, deletion, &target)?;
            let vacancy = || {
                evidence.canonical.confirm()?;
                evidence.previous_runtime.confirm()
            };
            let (unused, quarantine) =
                owned_names(&deletion.incoming.path, &operation.id, "runtime")?;
            require_absent(&unused)?;
            let (live, quarantined) = (
                open_if_present(&deletion.incoming.path)?,
                open_if_present(&quarantine)?,
            );
            if live.is_some() && quarantined.is_some() {
                return Err(held());
            }
            let live_present = live.is_some();
            let mut original = live.or(quarantined);
            if let Some(file) = &mut original {
                file.require_editable_security()?;
                if file.identity != deletion.incoming.original_identity
                    || file.parent_identity != deletion.incoming.parent_identity
                    || file.bytes(journal.maximum_bytes)? != evidence.incoming
                {
                    return Err(held());
                }
            }
            let incoming_absent = || -> Result<HeldAbsence> {
                let absent = HeldAbsence::open(&deletion.incoming.path)?;
                if absent.parent_identity != deletion.incoming.parent_identity {
                    return Err(held());
                }
                Ok(absent)
            };
            use LifecyclePhase::*;
            use SettingsActivationPointer::*;
            match (operation.phase, pointer, live_present, original.is_some()) {
                (Preparing, PreviousActive, true, true) => {
                    vacancy()?;
                    writer.advance(operation, Prepared)?;
                    checkpoint(self.faults.as_ref(), SettingsFaultPoint::Prepared)?;
                }
                (Prepared, PreviousActive, true, true) => {
                    vacancy()?;
                    original.take().ok_or_else(held)?.move_to(&quarantine)?;
                    let absence = incoming_absent()?;
                    vacancy()?;
                    absence.confirm()?;
                    checkpoint(self.faults.as_ref(), SettingsFaultPoint::RuntimeMoved)?;
                    writer.advance(operation, PayloadPublished)?;
                }
                (Prepared, PreviousActive, false, true) => {
                    let absence = incoming_absent()?;
                    vacancy()?;
                    absence.confirm()?;
                    writer.advance(operation, PayloadPublished)?;
                }
                (PayloadPublished, PreviousActive, false, true) => {
                    let absence = incoming_absent()?;
                    vacancy()?;
                    absence.confirm()?;
                    self.library
                        .activate_staged_exact(&journal.previous, &target)?;
                    self.faults
                        .check(LifecycleFaultPoint::ActivationMetadataCommitted)?;
                    vacancy()?;
                    absence.confirm()?;
                    writer.advance(operation, MetadataCommitted)?;
                }
                (PayloadPublished, TargetActive, false, true) => {
                    let absence = incoming_absent()?;
                    vacancy()?;
                    absence.confirm()?;
                    writer.advance(operation, MetadataCommitted)?;
                }
                (MetadataCommitted, TargetActive, false, true) => {
                    let absence = incoming_absent()?;
                    vacancy()?;
                    absence.confirm()?;
                    writer.advance(operation, CleanupPending)?;
                    checkpoint(self.faults.as_ref(), SettingsFaultPoint::CleanupPending)?;
                }
                (CleanupPending, TargetActive, false, _) => {
                    let absence = incoming_absent()?;
                    vacancy()?;
                    absence.confirm()?;
                    if let Some(original) = original {
                        original.retire()?;
                        checkpoint(self.faults.as_ref(), SettingsFaultPoint::RuntimeRetired)?;
                    }
                    vacancy()?;
                    absence.confirm()?;
                    self.inherit_native_settings_deletion(
                        operation,
                        &deletion.restore_id,
                        &target,
                        hash(&evidence.incoming),
                        &evidence.canonical,
                        &absence,
                    )?;
                    vacancy()?;
                    absence.confirm()?;
                    writer.retire(operation)?;
                    return Ok(());
                }
                _ => return Err(held()),
            }
        }
        Err(held())
    }

    fn verify_recorded_settings_deletion(
        &self,
        journal: &ActivationSettingsJournal,
        deletion: &ActivationSettingsDeletion,
        target: &InstallRecord,
    ) -> Result<DeletionEvidence> {
        let previous = &journal.previous;
        let prior = self.persistence_contract_for_install(previous)?;
        let next = self.persistence_contract_for_install(target)?;
        for policy in [&prior, &next] {
            if policy.port.adapter != AdapterKind::NativePortable
                || policy.writes_directly
                || policy.port.runtime_data_policy.is_some()
                || crate::persistence::requires_restore_receipt(&policy.port)
                || !policy
                    .port
                    .persistent_paths
                    .contains(&journal.relative_path)
                || policy
                    .port
                    .persistent_paths
                    .iter()
                    .any(|path| journal.relative_path.starts_with(&format!("{path}/")))
            {
                return Err(held());
            }
        }
        let prior_path = self
            .persistence_root(&prior.port, &previous.path)?
            .join(&journal.relative_path);
        let target_path = self
            .persistence_root(&next.port, &target.path)?
            .join(&journal.relative_path);
        if prior_path != deletion.previous_runtime.path || target_path != deletion.incoming.path {
            return Err(held());
        }
        let installer = Installer::new(self.library.clone())?;
        let before = installer
            .retained_settings_defaults(previous)?
            .ok_or_else(held)?;
        let after = installer
            .retained_settings_defaults(target)?
            .ok_or_else(held)?;
        let file = |row: &&GameSettingsFile| {
            row.id == journal.file_id && row.path == journal.relative_path
        };
        let old_file = before.contract.files.iter().find(file).ok_or_else(held)?;
        let new_file = after.contract.files.iter().find(file).ok_or_else(held)?;
        if old_file.format != new_file.format || new_file.maximum_bytes != journal.maximum_bytes {
            return Err(held());
        }
        let old = before
            .shipped
            .get(&old_file.path)
            .ok_or_else(held)?
            .verified_bytes(old_file)?;
        let incoming = after
            .shipped
            .get(&new_file.path)
            .ok_or_else(held)?
            .verified_bytes(new_file)?;
        let canonical = open_absence(&deletion.canonical)?;
        let previous_runtime = open_absence(&deletion.previous_runtime)?;
        if self
            .recorded_settings_restore_deletion(
                previous,
                old_file,
                &hash(&old),
                [&canonical, &previous_runtime],
                Some(&deletion.restore_id),
            )?
            .is_none()
        {
            return Err(held());
        }
        Ok(DeletionEvidence {
            canonical,
            previous_runtime,
            incoming,
        })
    }
}

struct DeletionEvidence {
    canonical: HeldAbsence,
    previous_runtime: HeldAbsence,
    incoming: Vec<u8>,
}

fn held() -> PortcoveError {
    PortcoveError::conflict(
        "recorded settings deletion needs review before activation can continue",
    )
}

fn absence_witness(file: &HeldAbsence) -> SettingsAbsenceWitness {
    SettingsAbsenceWitness {
        path: file.path.clone(),
        parent_identity: file.parent_identity.clone(),
    }
}

fn open_absence(witness: &SettingsAbsenceWitness) -> Result<HeldAbsence> {
    let file = HeldAbsence::open(&witness.path)?;
    if file.parent_identity != witness.parent_identity {
        return Err(held());
    }
    Ok(file)
}

fn require_absent(path: &Path) -> Result<()> {
    let parent = path.parent().ok_or_else(held)?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(held)?;
    crate::persistence::require_absent_path(parent, name)
}

fn open_if_present(path: &Path) -> Result<Option<HeldFile>> {
    match fs::symlink_metadata(path) {
        Ok(_) => HeldFile::open(path).map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            require_absent(path)?;
            Ok(None)
        }
        Err(error) => Err(error.into()),
    }
}
