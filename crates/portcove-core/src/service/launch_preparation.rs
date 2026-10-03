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
}

impl PortcoveService {
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
        self.require_definition_operation(
            &catalog,
            port,
            DefinitionOperationContext::observed(
                DefinitionOperation::Launch,
                true,
                active.verified,
            ),
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
        } = self.observe_managed_launch_inputs(port, active, source_override, operation)?;
        let port = catalog.port(&active.port_id)?;
        let checkpoint = || operation.map_or(Ok(()), OperationCoordinator::checkpoint);
        if active.path.join(LAUNCH_MARKER).is_file() {
            self.collect_user_data_from(port, &active.path)?;
            checkpoint()?;
        }
        self.restore_user_data_to(port, &active.path)?;
        checkpoint()?;
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
        self.refresh_upstream_setup_manifest(port, active, &spec.working_directory)?;
        checkpoint()?;
        Ok(spec)
    }
}
