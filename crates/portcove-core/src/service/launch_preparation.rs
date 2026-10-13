//! Read-only managed launch inputs followed by explicit preparation.
//!
//! Observed inputs describe checked facts, not authority to mutate or spawn.
//! The supervisor retains its port lock and operation checkpoints; preparation
//! still rechecks the executable and source after mutating saves/adapter data.

use std::path::Path;

use crate::{
    Catalog, DefinitionOperation, InstallQualification, InstallRecord, Installer,
    OperationCoordinator, Platform, PortDefinition, PortcoveError, Result, SourceRecord,
    definition_eligibility::DefinitionOperationContext, operation::LifecycleFaultPoint,
};

use super::{LAUNCH_MARKER, PortcoveService};

pub(super) struct ManagedLaunchInputs {
    catalog: Catalog,
    qualification: InstallQualification,
    source: Option<SourceRecord>,
    bios: Option<SourceRecord>,
}

impl PortcoveService {
    pub(super) fn managed_launch_context(
        &self,
        identity: Option<&crate::DefinitionSelectionIdentity>,
        active: &InstallRecord,
    ) -> Result<DefinitionOperationContext> {
        let mut context = DefinitionOperationContext::observed(
            DefinitionOperation::Launch,
            true,
            active.verified,
        );
        if let Some(identity) = identity
            && crate::definition_repository::publisher_policy::launch_assessment::requires_subject(
                &self.library.connection()?,
                identity,
            )?
        {
            context.launch_subject = Some(crate::install::verified_launch_subject(active)?);
        }
        Ok(context)
    }

    pub(super) fn observe_managed_launch_inputs(
        &self,
        port: &PortDefinition,
        active: &InstallRecord,
        source_override: Option<&Path>,
        operation: Option<&OperationCoordinator>,
    ) -> Result<ManagedLaunchInputs> {
        if port.id != active.port_id {
            return Err(PortcoveError::verification(
                "launch installation belongs to another port",
            ));
        }
        let catalog = self.installed_catalog(active)?;
        let port = catalog.port(&active.port_id)?;
        let qualification = self.installed_mutability_qualification(active)?;
        let checkpoint = || operation.map_or(Ok(()), OperationCoordinator::checkpoint);
        checkpoint()?;
        crate::runtime::require_ready(port, Platform::current()?, active)?;
        checkpoint()?;
        self.managed_install_root(&port.id, &active.path)?;
        checkpoint()?;
        Installer::new(self.library.clone())?.verify_critical(active, &qualification)?;
        checkpoint()?;
        let source = if let Some(path) = source_override {
            let profile_id = port.source_profile.as_deref().ok_or_else(|| {
                PortcoveError::usage(format!("{} does not accept a source override", port.name))
            })?;
            let source = Some(
                crate::source_inspection::inspect(&catalog, profile_id, path)?
                    .require_admitted_record()?,
            );
            checkpoint()?;
            source
        } else if let Some(profile) = &port.source_profile {
            if self.library.source(profile)?.is_some() {
                Some(self.verified_source_record_with_checkpoint(&catalog, profile, &checkpoint)?)
            } else {
                None
            }
        } else {
            None
        };
        let bios = if port.adapter == crate::AdapterKind::PsxRecompManaged {
            let bios = crate::psx::verified_launch_bios(&self.library, port, active, &checkpoint)?;
            if let Some(bios) = &bios {
                Self::verify_source_record_with_checkpoint(&catalog, bios, &checkpoint)?;
            }
            bios
        } else {
            None
        };
        self.require_definition_operation(
            &catalog,
            port,
            self.managed_launch_context(catalog.definition_selection(&port.id), active)?,
        )?;
        if crate::preparation::managed(port) {
            self.validate_preparation_receipt(port, active, source.as_ref())?;
            if !Installer::new(self.library.clone())?
                .verify_managed(active, &qualification)?
                .valid
            {
                return Err(PortcoveError::verification(
                    "prepared game data changed; repair or prepare it again",
                ));
            }
        }
        Ok(ManagedLaunchInputs {
            catalog,
            qualification,
            source,
            bios,
        })
    }

    pub(super) fn prepare_launch_for_install(
        &self,
        port: &PortDefinition,
        active: &InstallRecord,
        source_override: Option<&Path>,
        operation: Option<&OperationCoordinator>,
    ) -> Result<crate::LaunchSpec> {
        let ManagedLaunchInputs {
            catalog,
            qualification,
            source,
            bios,
        } = self.observe_managed_launch_inputs(port, active, source_override, operation)?;
        let port = catalog.port(&active.port_id)?;
        let checkpoint = || operation.map_or(Ok(()), OperationCoordinator::checkpoint);
        if active.path.join(LAUNCH_MARKER).is_file() {
            self.collect_user_data_from(port, &active.path)?;
            checkpoint()?;
        }
        self.restore_user_data_to(port, &active.path)?;
        checkpoint()?;
        self.recheck_launch_bios(&catalog, port, active, bios.as_ref(), &checkpoint)?;
        let selected_executable =
            Installer::new(self.library.clone())?.verify_critical(active, &qualification)?;
        checkpoint()?;
        let spec = self
            .adapters
            .get(port.adapter)
            .prepare_launch_with_executable(
                crate::LaunchSpecRequest {
                    library: &self.library,
                    port,
                    platform: Platform::current()?,
                    install_root: &active.path,
                    selected_executable: &selected_executable,
                    source: source.as_ref().map(|record| record.path.as_path()),
                    source_record: source.as_ref(),
                },
                &checkpoint,
            )?;
        self.faults.check(LifecycleFaultPoint::SourcePrepared)?;
        checkpoint()?;
        if let Some(source) = &source {
            Self::verify_source_record_with_checkpoint(&catalog, source, &checkpoint)?;
        }
        checkpoint()?;
        self.recheck_launch_bios(&catalog, port, active, bios.as_ref(), &checkpoint)?;
        self.refresh_upstream_setup_manifest(port, active, &spec.working_directory)?;
        checkpoint()?;
        Ok(spec)
    }
    fn recheck_launch_bios(
        &self,
        catalog: &Catalog,
        port: &PortDefinition,
        active: &InstallRecord,
        observed: Option<&SourceRecord>,
        checkpoint: &dyn Fn() -> Result<()>,
    ) -> Result<()> {
        if port.adapter != crate::AdapterKind::PsxRecompManaged {
            return Ok(());
        }
        let current = crate::psx::verified_launch_bios(&self.library, port, active, checkpoint)?;
        if serde_json::to_value(&current)? != serde_json::to_value(observed)? {
            return Err(PortcoveError::conflict(
                "registered PS1 BIOS changed during launch preparation",
            ));
        }
        if let Some(bios) = observed {
            Self::verify_source_record_with_checkpoint(catalog, bios, checkpoint)?;
            let current =
                crate::psx::verified_launch_bios(&self.library, port, active, &|| Ok(()))?;
            if serde_json::to_value(&current)? != serde_json::to_value(observed)? {
                return Err(PortcoveError::conflict(
                    "registered PS1 BIOS changed during launch preparation",
                ));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_bios_checkpoint_recheck_rejects_changed_registration_and_bytes() {
        let temporary = tempfile::tempdir().unwrap();
        let (library, catalog, install, bios) = crate::psx::bios_launch_fixture(temporary.path());
        let service = PortcoveService::new(library.clone()).unwrap();
        let port = catalog.port(&install.port_id).unwrap();
        service
            .recheck_launch_bios(&catalog, port, &install, Some(&bios), &|| Ok(()))
            .unwrap();
        let mut stale = bios.clone();
        stale.updated_at += 1;
        library.register_source(&stale).unwrap();
        let error = service
            .recheck_launch_bios(&catalog, port, &install, Some(&bios), &|| Ok(()))
            .unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Conflict);
        library.register_source(&bios).unwrap();
        let calls = std::cell::Cell::new(0);
        let checkpoint = || {
            calls.set(calls.get() + 1);
            // helper has three callbacks; admission has four more. Change the
            // registration at admission's final checkpoint after its last hash.
            if calls.get() == 7 {
                library.register_source(&stale)?;
            }
            Ok(())
        };
        assert!(
            service
                .recheck_launch_bios(&catalog, port, &install, Some(&bios), &checkpoint)
                .is_err()
        );
        assert_eq!(calls.get(), 7);
        library.register_source(&bios).unwrap();
        let changed = std::cell::Cell::new(false);
        let checkpoint = || {
            if !changed.replace(true) {
                std::fs::write(&bios.path, b"changed at launch checkpoint")?;
            }
            Ok(())
        };
        assert!(
            service
                .recheck_launch_bios(&catalog, port, &install, Some(&bios), &checkpoint)
                .is_err()
        );
        assert_eq!(
            std::fs::read(&bios.path).unwrap(),
            b"changed at launch checkpoint"
        );
    }
}
