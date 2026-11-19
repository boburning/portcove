//! Reopen retained settings custody for an already staged activation.

use super::transaction::{Leg, LegState, hash};
use super::*;
use crate::game_settings::{RetainedSettingsDefaults, windows::HeldFile};
use crate::operation::game_settings::{SettingsActivationPointer, activation_pointer};

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
    _canonical: Leg,
    _runtime: Option<Leg>,
    _previous_runtime: Option<HeldFile>,
}

impl PortcoveService {
    /// Revalidate both retained archives and pin all physical objects under
    /// exact recovery ownership for the checked writer's next transition.
    pub(in crate::service) fn verify_settings_activation_recovery(
        &self,
        operation: &LifecycleOperation,
    ) -> Result<SettingsActivationRecovery> {
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
        if hash(&old) != payload.canonical.previous_sha256
            || hash(&new) != payload.canonical.proposed_sha256
        {
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

        let canonical = Leg::open(
            &payload.canonical,
            &operation.id,
            "canonical",
            payload.maximum_bytes,
        )?;
        let runtime = payload
            .runtime
            .as_ref()
            .map(|leg| Leg::open(leg, &operation.id, "runtime", payload.maximum_bytes))
            .transpose()?;
        for leg in std::iter::once(&canonical).chain(runtime.iter()) {
            if leg
                .before
                .as_deref()
                .is_some_and(|bytes| bytes != old.as_slice())
                || leg.after != new
            {
                return Err(conflict());
            }
        }
        let next = resume_step(
            operation.phase,
            pointer,
            canonical.state,
            runtime.as_ref().map(|leg| leg.state),
        )?;
        Ok(SettingsActivationRecovery {
            next,
            _canonical: canonical,
            _runtime: runtime,
            _previous_runtime: previous_runtime,
        })
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
