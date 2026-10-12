//! Private normalized disc inputs, never generator or installation completion.
use std::{fs, path::PathBuf};

use serde::{Deserialize, Serialize};

use super::{
    BootstrapWitness, PsxManagedPreparation, PsxStageWitness, bootstrap::BootstrapBinding,
    preparation_from_identity, preparation_identity, stage::GeneratedTree,
};
use crate::{Library, OperationCoordinator, PortcoveError, Result, operation::LifecycleOperation};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct NormalizedInputWitness {
    schema_version: u32,
    bootstrap: BootstrapWitness,
    binding: BootstrapBinding,
    inputs: Vec<u8>,
    helper_path: PathBuf,
    helper: crate::external_runtime::InspectedFile,
    disc: GeneratedTree,
    cue: PathBuf,
}

impl NormalizedInputWitness {
    #[cfg(test)]
    pub(super) fn inert_fixture(
        bootstrap: BootstrapWitness,
        preparation: &PsxManagedPreparation,
        disc: &std::path::Path,
        helper: &std::path::Path,
        operation: &OperationCoordinator,
    ) -> Result<Self> {
        let helper_path = fs::canonicalize(helper)?;
        Ok(Self {
            schema_version: 1,
            binding: bootstrap.binding()?,
            bootstrap,
            inputs: preparation_identity(preparation)?,
            helper: inspect_helper(&helper_path, operation)?,
            helper_path,
            cue: fs::canonicalize(disc.join("disc.cue"))?,
            disc: GeneratedTree::capture(disc, operation, true)?,
        })
    }

    pub(crate) fn port_id(&self) -> &str {
        self.bootstrap.port_id()
    }

    pub(crate) fn prepare(
        bootstrap: BootstrapWitness,
        library: &Library,
        journal: &LifecycleOperation,
        preparation: &PsxManagedPreparation,
        operation: &OperationCoordinator,
    ) -> (Result<Self>, bool) {
        let mut quiesced = true;
        let result = (|| {
            let binding = bootstrap.binding()?;
            require_bound_bootstrap(&bootstrap, &binding)?;
            let store = crate::operation::OperationStore::new(library.clone());
            store.require_psx_normalization_vacant(operation)?;
            binding.require_current(library, operation.operation_id())?;
            bootstrap.verify(library, journal, operation)?;
            bootstrap.require_preparation(preparation)?;
            let configuration = super::PreparationConfiguration::from_preparation(preparation)?;
            let inputs = preparation_identity(preparation)?;
            // Source objects are freshly verified around the one supervised helper.
            verify_sources(preparation, operation)?;
            let selected = crate::adapter::resolve_chdman()?;
            crate::path::refuse_symlink_ancestors(&selected)?;
            let helper_path = fs::canonicalize(selected)?;
            let helper = inspect_helper(&helper_path, operation)?;
            let temporary = super::retained_source_workspace(bootstrap.payload_root())?;
            let cue = super::materialize_managed_disc(
                configuration.primary_source,
                &temporary,
                Some(&helper_path),
                operation,
                &mut quiesced,
            )?;
            let disc = GeneratedTree::capture(&temporary, operation, quiesced)?;
            verify_sources(preparation, operation)?;
            if inspect_helper(&helper_path, operation)? != helper {
                return Err(PortcoveError::verification(
                    "PS1 normalization helper changed during materialization",
                ));
            }
            binding.require_current(library, operation.operation_id())?;
            Ok(Self {
                schema_version: 1,
                bootstrap,
                binding,
                inputs,
                helper_path,
                helper,
                disc,
                cue: fs::canonicalize(cue)?,
            })
        })();
        (result, quiesced)
    }
}

fn inspect_helper(
    path: &std::path::Path,
    operation: &OperationCoordinator,
) -> Result<crate::external_runtime::InspectedFile> {
    // Capture is a comparison baseline, not authentication. Selection remains
    // the reviewed host-tool route; native admission separately binds its digest.
    crate::path::refuse_symlink_ancestors(path)?;
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.len() > 64 * 1024 * 1024 {
        return Err(PortcoveError::verification(
            "PS1 normalization helper size or type refused",
        ));
    }
    crate::external_runtime::hash_stable_file(path, metadata.len(), &|| operation.checkpoint())
}

fn require_bound_bootstrap(bootstrap: &BootstrapWitness, binding: &BootstrapBinding) -> Result<()> {
    if crate::operation::psx_witness_json(bootstrap)? != binding.receipt().1 {
        return Err(PortcoveError::verification(
            "PS1 normalized input predecessor context changed",
        ));
    }
    Ok(())
}

fn verify_sources(
    preparation: &PsxManagedPreparation,
    operation: &OperationCoordinator,
) -> Result<()> {
    operation.checkpoint()?;
    crate::adapter::verify_source_storage_identity(&preparation.source, "PS1 source")?;
    if let Some(bios) = &preparation.bios {
        super::verify_raw_bios(bios, &|| operation.checkpoint())?;
    }
    operation.checkpoint()
}

impl PsxStageWitness for NormalizedInputWitness {
    fn library_id(&self) -> &str {
        self.bootstrap.library_id()
    }

    fn bootstrap_parent(&self) -> Option<(&str, &str)> {
        Some(self.binding.receipt())
    }

    fn verify(
        &self,
        library: &Library,
        journal: &LifecycleOperation,
        operation: &OperationCoordinator,
    ) -> Result<()> {
        self.binding
            .require_current(library, operation.operation_id())?;
        require_bound_bootstrap(&self.bootstrap, &self.binding)?;
        self.bootstrap.verify(library, journal, operation)?;
        let staging = journal
            .paths
            .staging
            .as_ref()
            .expect("bootstrap checked staging");
        let expected_parent = fs::canonicalize(staging)?;
        crate::path::refuse_symlink_ancestors(&self.cue)?;
        if self.schema_version != 1
            || self.disc.operation_id() != journal.id
            || self.disc.root().parent() != Some(expected_parent.as_path())
            || self.cue != self.disc.root().join("disc.cue")
            || fs::canonicalize(&self.cue)? != self.cue
        {
            return Err(PortcoveError::verification(
                "PS1 normalized input custody changed",
            ));
        }
        let preparation = preparation_from_identity(&self.inputs)?;
        super::PreparationConfiguration::from_preparation(&preparation)?;
        self.bootstrap.require_preparation(&preparation)?;
        verify_sources(&preparation, operation)?;
        if inspect_helper(&self.helper_path, operation)? != self.helper {
            return Err(PortcoveError::verification(
                "PS1 normalized input helper changed",
            ));
        }
        self.disc.verify(self.disc.root(), operation)
    }
}
