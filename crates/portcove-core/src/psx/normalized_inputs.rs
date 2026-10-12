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
    #[serde(skip)]
    persisted_sha256: Option<String>,
    #[serde(skip)]
    persisted_json: Option<String>,
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
            persisted_sha256: None,
            persisted_json: None,
        })
    }

    pub(crate) fn port_id(&self) -> &str {
        self.bootstrap.port_id()
    }

    pub(crate) fn artifact(&self) -> &crate::ArtifactIdentity {
        self.bootstrap.artifact()
    }

    pub(crate) fn prepare(
        decoded: crate::operation::UnverifiedNormalizationBootstrap,
        library: &Library,
        journal: &LifecycleOperation,
        owned_start: &LifecycleOperation,
        preparation: &PsxManagedPreparation,
        operation: &OperationCoordinator,
    ) -> (Result<Self>, bool) {
        let mut quiesced = true;
        #[cfg(feature = "qualification-fixtures")]
        let mut trace =
            super::qualification_trace::Trace::new(operation.operation_id(), "normalized_inputs");
        let result = (|| {
            decoded.require_owned_worker(library, journal, owned_start, operation)?;
            let bootstrap = decoded.witness();
            #[cfg(feature = "qualification-fixtures")]
            trace.phase("predecessor_binding");
            let binding = bootstrap.binding()?;
            require_bound_bootstrap(&bootstrap, &binding)?;
            let store = crate::operation::OperationStore::new(library.clone());
            store.require_psx_normalization_vacant(operation)?;
            binding.require_current(library, operation.operation_id())?;
            #[cfg(feature = "qualification-fixtures")]
            trace.phase("bootstrap_verification");
            bootstrap.verify(library, journal, operation)?;
            bootstrap.require_preparation(preparation)?;
            let configuration = super::PreparationConfiguration::from_preparation(preparation)?;
            let inputs = preparation_identity(preparation)?;
            // Source objects are freshly verified around the one supervised helper.
            #[cfg(feature = "qualification-fixtures")]
            trace.phase("source_and_helper_verification");
            verify_sources(preparation, operation)?;
            let selected = crate::adapter::resolve_chdman()?;
            crate::path::refuse_symlink_ancestors(&selected)?;
            let helper_path = fs::canonicalize(selected)?;
            let helper = inspect_helper(&helper_path, operation)?;
            let temporary = super::retained_source_workspace(bootstrap.payload_root())?;
            decoded.require_owned_worker(library, journal, owned_start, operation)?;
            #[cfg(feature = "qualification-fixtures")]
            trace.phase("disc_materialization");
            let cue = super::materialize_managed_disc(
                configuration.primary_source,
                &temporary,
                Some(&helper_path),
                operation,
                &mut quiesced,
            )?;
            #[cfg(feature = "qualification-fixtures")]
            trace.phase("disc_capture");
            let disc = GeneratedTree::capture(&temporary, operation, quiesced)?;
            #[cfg(feature = "qualification-fixtures")]
            trace.phase("post_materialization_verification");
            verify_sources(preparation, operation)?;
            if inspect_helper(&helper_path, operation)? != helper {
                return Err(PortcoveError::verification(
                    "PS1 normalization helper changed during materialization",
                ));
            }
            binding.require_current(library, operation.operation_id())?;
            let witness = Self {
                schema_version: 1,
                bootstrap: decoded.into_witness(),
                binding,
                inputs,
                helper_path,
                helper,
                disc,
                cue: fs::canonicalize(cue)?,
                persisted_sha256: None,
                persisted_json: None,
            };
            #[cfg(feature = "qualification-fixtures")]
            trace.complete();
            Ok(witness)
        })();
        (result, quiesced)
    }

    pub(crate) fn require_request(
        &self,
        contract: &serde_json::Value,
        preparation: &PsxManagedPreparation,
    ) -> Result<()> {
        self.bootstrap.require_request(contract, preparation)?;
        if self.inputs != preparation_identity(preparation)? {
            return Err(PortcoveError::conflict(
                "PS1 materialization request changed",
            ));
        }
        Ok(())
    }

    pub(crate) fn loaded_receipt(&self) -> Result<(&str, &str)> {
        Ok((
            self.persisted_sha256
                .as_deref()
                .ok_or_else(|| PortcoveError::state("PS1 materialization was not store-loaded"))?,
            self.persisted_json.as_deref().ok_or_else(|| {
                PortcoveError::state("PS1 materialization bytes were not store-loaded")
            })?,
        ))
    }

    /// Ownership checks only. This grants provisional retention, never fresh
    /// normalization or authority to replay the helper or invoke a generator.
    pub(crate) fn verify_materialized_context(
        &self,
        library: &Library,
        journal: &LifecycleOperation,
        operation: &OperationCoordinator,
    ) -> Result<()> {
        self.binding
            .require_current(library, operation.operation_id())?;
        require_bound_bootstrap(&self.bootstrap, &self.binding)?;
        self.bootstrap.verify_context(library, journal, operation)?;
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
        operation.checkpoint()
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
    fn record_load(&mut self, sha256: String) {
        self.persisted_sha256 = Some(sha256);
    }

    fn record_load_json(&mut self, json: String) {
        self.persisted_json = Some(json);
    }
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
        self.verify_materialized_context(library, journal, operation)?;
        self.bootstrap.verify(library, journal, operation)?;
        let preparation = preparation_from_identity(&self.inputs)?;
        verify_sources(&preparation, operation)?;
        if inspect_helper(&self.helper_path, operation)? != self.helper {
            return Err(PortcoveError::verification(
                "PS1 normalized input helper changed",
            ));
        }
        self.disc.verify(self.disc.root(), operation)
    }
}
