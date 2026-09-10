//! Preparation eligibility and launch validation share the registered core state.
use super::{RECEIPT_FILE, execution::PreparationReceipt};
use crate::{
    AdapterKind, InstallRecord, Installer, Platform, PortDefinition, PortcoveError,
    PortcoveService, Result, SourceRecord,
};

pub(crate) fn managed(port: &PortDefinition) -> bool {
    port.adapter == AdapterKind::UpstreamManagedSetup && !port.setup_output_paths.is_empty()
}

impl PortcoveService {
    pub(crate) fn validate_preparation_receipt(
        &self,
        port: &PortDefinition,
        install: &InstallRecord,
        source: Option<&SourceRecord>,
    ) -> Result<()> {
        if !managed(port) {
            return Ok(());
        }
        let installer = Installer::new(self.library().clone())?;
        let working = crate::adapter::launch_working_directory(
            port.adapter,
            port,
            &install.path,
            &install.path.join(&install.selected_executable),
        )?;
        let marker = port
            .setup_marker
            .as_deref()
            .ok_or_else(|| PortcoveError::state("preparation has no output marker"))?;
        // A manually created marker cannot establish readiness. Both legacy and
        // new prepared installations must have admitted this exact output.
        installer.verify_recorded_member(install, &working.join(marker))?;
        let bytes = match installer.read_verified_member(install, RECEIPT_FILE, 1024 * 1024) {
            Ok(bytes) => bytes,
            Err(error) if error.code == crate::ErrorCode::NotFound => {
                return crate::adapter::validate_completed_legacy_setup(
                    port, install, &working, source,
                );
            }
            Err(error) => return Err(error),
        };
        let receipt: PreparationReceipt = serde_json::from_slice(&bytes)?;
        let profile = port
            .source_profile
            .as_deref()
            .ok_or_else(|| PortcoveError::state("preparation has no source profile"))?;
        let catalog = self.installed_catalog(install)?;
        let definition = crate::signed_catalog::digest(&serde_json::to_vec(&(
            port,
            catalog.source_profile(profile)?,
        ))?);
        let inputs = &receipt.inputs;
        let source_matches = source.is_some_and(|source| {
            source.profile_id == inputs.source.profile_id
                && source.path == inputs.source.path
                && source.sha256 == inputs.source.sha256
                && source.size == inputs.source.size
                && source.storage_sha256 == inputs.source.storage_sha256
                && source.storage_size == inputs.source.storage_size
        });
        if receipt.format_version != 1
            || inputs.definition_sha256 != definition
            || inputs.install.artifact != install.artifact
            || inputs.install.runtime != install.runtime
            || inputs.install.version != install.version
            || inputs.host != Platform::current()?
            || inputs.options.target != inputs.host
            || !source_matches
        {
            return Err(PortcoveError::conflict(
                "prepared inputs changed; review and prepare game data again",
            ));
        }
        Ok(())
    }
}
