//! Reopen retained settings custody for an already staged activation.

use super::transaction::{
    Leg, LegState, StageBinding, checked_bytes, checkpoint, hash, prepare_file_stage,
};
use super::*;
use crate::game_settings::{RetainedSettingsDefaults, windows::HeldFile};
use crate::operation::SettingsFaultPoint;
use crate::operation::game_settings::{
    SettingsActivationPointer, SettingsActivationWriter, activation_pointer, owned_names,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::service) enum SettingsActivationResume {
    PublishCanonical,
    PublishRuntime,
    CommitPointer,
    RecordCommittedPointer,
    RetirePreimages,
}

pub(in crate::service) struct SettingsActivationRecovery {
    pub(in crate::service) next: SettingsActivationResume,
    canonical: Leg,
    runtime: Option<Leg>,
    _previous_runtime: Option<HeldFile>,
}

struct RecoveryInputs {
    pointer: SettingsActivationPointer,
    old: Vec<u8>,
    new: Vec<u8>,
    previous_runtime: Option<HeldFile>,
}

impl PortcoveService {
    pub(in crate::service) fn recover_checked_settings_activation(
        &self,
        writer: &SettingsActivationWriter<'_>,
        operation: &mut LifecycleOperation,
    ) -> Result<()> {
        self.require_completed_backup_restore(&operation.port_id)?;
        self.require_completed_backup_deletion(&operation.port_id)?;
        if operation
            .settings_activation
            .as_ref()
            .is_some_and(|journal| journal.deletion.is_some())
        {
            return self.recover_recorded_settings_deletion(writer, operation);
        }
        for _ in 0..7 {
            writer.confirm(operation)?;
            let target = operation.install.clone().ok_or_else(conflict)?;
            let payload = operation.settings_activation.clone().ok_or_else(conflict)?;
            let canonical = payload.canonical.as_ref().ok_or_else(conflict)?;
            let status = self.library.status(&operation.port_id, target.channel)?;
            if activation_pointer(operation, &status)? == SettingsActivationPointer::PreviousActive
            {
                self.require_activation_gates(&target, None)?;
            }
            if operation.phase == LifecyclePhase::Preparing {
                self.prepare_activation_settings_stages(writer, operation)?;
                writer.advance(operation, LifecyclePhase::Prepared)?;
                checkpoint(self.faults.as_ref(), SettingsFaultPoint::Prepared)?;
                continue;
            }
            let maximum = payload.maximum_bytes;
            let mut held = self.verify_settings_activation_recovery(operation)?;
            use SettingsActivationResume::*;
            match held.next {
                PublishCanonical => {
                    held.canonical.publish(
                        canonical,
                        &operation.id,
                        "canonical",
                        maximum,
                        self.faults.as_ref(),
                    )?;
                    writer.advance(operation, LifecyclePhase::PayloadPublished)?;
                }
                PublishRuntime => {
                    held.runtime.as_mut().ok_or_else(conflict)?.publish(
                        payload.runtime.as_ref().ok_or_else(conflict)?,
                        &operation.id,
                        "runtime",
                        maximum,
                        self.faults.as_ref(),
                    )?;
                }
                CommitPointer => {
                    self.library
                        .activate_staged_exact(&payload.previous, &target)?;
                    self.faults
                        .check(LifecycleFaultPoint::ActivationMetadataCommitted)?;
                    writer.advance(operation, LifecyclePhase::MetadataCommitted)?;
                }
                RecordCommittedPointer => {
                    writer.advance(operation, LifecyclePhase::MetadataCommitted)?
                }
                RetirePreimages => {
                    if operation.phase == LifecyclePhase::MetadataCommitted {
                        writer.advance(operation, LifecyclePhase::CleanupPending)?;
                        checkpoint(self.faults.as_ref(), SettingsFaultPoint::CleanupPending)?;
                    }
                    held.canonical.retire_preimage(canonical, maximum)?;
                    checkpoint(self.faults.as_ref(), SettingsFaultPoint::CanonicalRetired)?;
                    if let Some((leg, custody)) =
                        held.runtime.as_mut().zip(payload.runtime.as_ref())
                    {
                        leg.retire_preimage(custody, maximum)?;
                        checkpoint(self.faults.as_ref(), SettingsFaultPoint::RuntimeRetired)?;
                    }
                    writer.retire(operation)?;
                    return Ok(());
                }
            }
        }
        Err(conflict())
    }

    fn prepare_activation_settings_stages(
        &self,
        writer: &SettingsActivationWriter<'_>,
        operation: &mut LifecycleOperation,
    ) -> Result<()> {
        let inputs = self.settings_activation_inputs(operation)?;
        let payload = operation.settings_activation.clone().ok_or_else(conflict)?;
        let id = operation.id.clone();
        let open_original = |role: &str,
                             custody: &crate::operation::game_settings::FileCustody|
         -> Result<HeldFile> {
            let (_, old) = owned_names(&custody.path, &id, role)?;
            match fs::symlink_metadata(old) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
                Ok(_) => return Err(conflict()),
                Err(error) => return Err(error.into()),
            }
            let mut held = HeldFile::open(&custody.path)?;
            held.require_editable_security()?;
            let expected = inputs.preimage(custody);
            if checked_bytes(&mut held, custody, true, payload.maximum_bytes)? != expected {
                return Err(conflict());
            }
            Ok(held)
        };
        let canonical_custody = payload.canonical.as_ref().ok_or_else(conflict)?;
        let canonical = open_original("canonical", canonical_custody)?;
        let runtime = payload
            .runtime
            .as_ref()
            .map(|custody| open_original("runtime", custody))
            .transpose()?;
        for (role, original, custody) in
            std::iter::once(("canonical", &canonical, canonical_custody)).chain(
                runtime
                    .as_ref()
                    .zip(payload.runtime.as_ref())
                    .map(|(original, custody)| ("runtime", original, custody)),
            )
        {
            if role == "runtime" {
                checkpoint(self.faults.as_ref(), SettingsFaultPoint::BetweenStages)?;
            }
            prepare_file_stage(
                &id,
                role,
                &inputs.new,
                original,
                custody,
                self.faults.as_ref(),
                |binding| match binding {
                    StageBinding::Bind(identity) => writer.bind_stage(operation, role, identity),
                    StageBinding::Confirm => writer.confirm(operation),
                },
            )?;
        }
        Ok(())
    }

    /// Revalidate both retained archives and pin all physical objects under
    /// exact recovery ownership for the checked writer's next transition.
    pub(in crate::service) fn verify_settings_activation_recovery(
        &self,
        operation: &LifecycleOperation,
    ) -> Result<SettingsActivationRecovery> {
        let inputs = self.settings_activation_inputs(operation)?;
        let payload = operation
            .settings_activation
            .as_ref()
            .ok_or_else(conflict)?;
        let custody = payload.canonical.as_ref().ok_or_else(conflict)?;
        let canonical = Leg::open(custody, &operation.id, "canonical", payload.maximum_bytes)?;
        let runtime = payload
            .runtime
            .as_ref()
            .map(|leg| Leg::open(leg, &operation.id, "runtime", payload.maximum_bytes))
            .transpose()?;
        for (leg, custody) in std::iter::once((&canonical, custody))
            .chain(runtime.as_ref().zip(payload.runtime.as_ref()))
        {
            if leg
                .before
                .as_deref()
                .is_some_and(|bytes| bytes != inputs.preimage(custody))
                || leg.after != inputs.new
            {
                return Err(conflict());
            }
        }
        let next = resume_step(
            operation.phase,
            inputs.pointer,
            canonical.state,
            runtime.as_ref().map(|leg| leg.state),
        )?;
        Ok(SettingsActivationRecovery {
            next,
            canonical,
            runtime,
            _previous_runtime: inputs.previous_runtime,
        })
    }

    fn settings_activation_inputs(&self, operation: &LifecycleOperation) -> Result<RecoveryInputs> {
        crate::operation::game_settings::validate_journal(&self.library, operation)?;
        if Platform::current()? != Platform::WindowsX86_64 {
            return Err(PortcoveError::unsupported(
                "settings activation custody requires Windows x86-64",
            ));
        }
        let payload = operation
            .settings_activation
            .as_ref()
            .ok_or_else(conflict)?;
        let target = operation.install.as_ref().ok_or_else(conflict)?;
        let previous = &payload.previous;
        let status = self.library.status(&operation.port_id, target.channel)?;
        let pointer = activation_pointer(operation, &status)?;
        let installer = Installer::new(self.library.clone())?;
        let prior_defaults = installer
            .retained_settings_defaults(previous)?
            .ok_or_else(conflict)?;
        let incoming_defaults = installer
            .retained_settings_defaults(target)?
            .ok_or_else(conflict)?;
        let incoming_file = incoming_defaults
            .contract
            .files
            .iter()
            .find(|file| {
                file.id == payload.file_id
                    && file.path == payload.relative_path
                    && file.maximum_bytes == payload.maximum_bytes
            })
            .ok_or_else(conflict)?;
        let prior_file = prior_defaults
            .contract
            .files
            .iter()
            .find(|file| {
                file.id == incoming_file.id
                    && file.path == incoming_file.path
                    && file.format == incoming_file.format
            })
            .ok_or_else(conflict)?;
        let old = retained_default_bytes(&prior_defaults, prior_file)?;
        let new = retained_default_bytes(&incoming_defaults, incoming_file)?;
        let canonical = payload.canonical.as_ref().ok_or_else(conflict)?;
        if hash(&old) != canonical.previous_sha256 || hash(&new) != canonical.proposed_sha256 {
            return Err(conflict());
        }

        let runtime_path = |install: &InstallRecord| -> Result<Option<PathBuf>> {
            let contract = self.persistence_contract_for_install(install)?;
            (!contract.writes_directly)
                .then(|| {
                    self.persistence_root(&contract.port, &install.path)
                        .map(|root| root.join(&payload.relative_path))
                })
                .transpose()
        };
        let prior_path = runtime_path(previous)?;
        let target_path = runtime_path(target)?;
        if prior_path.as_ref()
            != payload
                .previous_runtime
                .as_ref()
                .map(|witness| &witness.path)
            || target_path.as_ref() != payload.runtime.as_ref().map(|leg| &leg.path)
        {
            return Err(conflict());
        }
        let previous_runtime = payload
            .previous_runtime
            .as_ref()
            .map(|witness| {
                let mut held = HeldFile::open(&witness.path)?;
                if held.identity != witness.original_identity
                    || held.parent_identity != witness.parent_identity
                    || held.bytes(prior_file.maximum_bytes)? != old
                {
                    return Err(conflict());
                }
                Ok(held)
            })
            .transpose()?;

        Ok(RecoveryInputs {
            pointer,
            old,
            new,
            previous_runtime,
        })
    }
}

impl RecoveryInputs {
    fn preimage(&self, leg: &crate::operation::game_settings::FileCustody) -> &[u8] {
        if leg.previous_sha256 == leg.proposed_sha256 {
            &self.new
        } else {
            &self.old
        }
    }
}

fn retained_default_bytes(
    defaults: &RetainedSettingsDefaults,
    file: &GameSettingsFile,
) -> Result<Vec<u8>> {
    defaults
        .shipped
        .get(&file.path)
        .ok_or_else(conflict)?
        .verified_bytes(file)
}

fn conflict() -> PortcoveError {
    PortcoveError::conflict(
        "settings activation custody changed; preserve the installation and its retained configuration",
    )
}

fn resume_step(
    phase: LifecyclePhase,
    pointer: SettingsActivationPointer,
    canonical: LegState,
    runtime: Option<LegState>,
) -> Result<SettingsActivationResume> {
    use SettingsActivationPointer::{PreviousActive, TargetActive};
    use SettingsActivationResume::*;
    let published = runtime.is_none_or(|state| state == LegState::Published);
    match (phase, pointer, canonical) {
        (
            LifecyclePhase::Prepared,
            PreviousActive,
            LegState::Before | LegState::Gap | LegState::Published,
        ) if runtime.is_none_or(|state| state == LegState::Before) => Ok(PublishCanonical),
        (LifecyclePhase::PayloadPublished, PreviousActive, LegState::Published) if published => {
            Ok(CommitPointer)
        }
        (LifecyclePhase::PayloadPublished, PreviousActive, LegState::Published)
            if matches!(runtime, Some(LegState::Before | LegState::Gap)) =>
        {
            Ok(PublishRuntime)
        }
        (LifecyclePhase::PayloadPublished, TargetActive, LegState::Published) if published => {
            Ok(RecordCommittedPointer)
        }
        (LifecyclePhase::MetadataCommitted, TargetActive, LegState::Published) if published => {
            Ok(RetirePreimages)
        }
        (LifecyclePhase::CleanupPending, TargetActive, LegState::Published | LegState::Cleaned)
            if runtime
                .is_none_or(|state| matches!(state, LegState::Published | LegState::Cleaned)) =>
        {
            Ok(RetirePreimages)
        }
        _ => Err(conflict()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interrupted_settings_activation_requires_exact_leg_and_pointer_order() {
        use LegState::{Before, Cleaned, Gap, Published};
        use LifecyclePhase::{CleanupPending, MetadataCommitted, PayloadPublished, Prepared};
        use SettingsActivationPointer::{PreviousActive, TargetActive};
        use SettingsActivationResume::*;
        for (phase, pointer, canonical, runtime, expected) in [
            (
                Prepared,
                PreviousActive,
                Gap,
                Some(Before),
                PublishCanonical,
            ),
            (
                PayloadPublished,
                PreviousActive,
                Published,
                Some(Gap),
                PublishRuntime,
            ),
            (
                PayloadPublished,
                PreviousActive,
                Published,
                Some(Published),
                CommitPointer,
            ),
            (
                PayloadPublished,
                TargetActive,
                Published,
                Some(Published),
                RecordCommittedPointer,
            ),
            (
                CleanupPending,
                TargetActive,
                Cleaned,
                Some(Published),
                RetirePreimages,
            ),
        ] {
            assert_eq!(
                resume_step(phase, pointer, canonical, runtime).unwrap(),
                expected
            );
        }
        assert!(resume_step(PayloadPublished, TargetActive, Published, Some(Gap)).is_err());
        assert!(resume_step(Prepared, PreviousActive, Gap, Some(Published)).is_err());
        assert!(resume_step(MetadataCommitted, TargetActive, Published, Some(Cleaned)).is_err());
    }
}

#[cfg(test)]
#[path = "activation_recovery_custody_tests.rs"]
mod custody_tests;
