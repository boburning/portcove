//! Private normalized disc inputs, never generator or installation completion.
use std::{fs, path::PathBuf};

use serde::{Deserialize, Serialize};

use super::{
    BootstrapWitness, PsxManagedPreparation, PsxStageWitness, bootstrap::BootstrapBinding,
    preparation_from_identity, preparation_identity, stage::GeneratedTree,
};
use crate::{Library, OperationCoordinator, PortcoveError, Result, operation::LifecycleOperation};

#[derive(Clone, Copy)]
enum NormalizedReadContext<'a> {
    Current(&'a LifecycleOperation),
    Closed(&'a crate::operation::ClosedGenerationPredecessor),
}

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

/// Complete positively closed output capture, still no configure authority.
/// Store retention and full sealing are distinct transitions; native setup
/// cannot be replayed merely because this value has not yet been promoted.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProvisionalGeneratedInstall {
    normalized: NormalizedInputWitness,
    normalized_sha256: String,
    normalized_json: String,
    generated: super::GeneratedInstall,
    outputs: super::generation_outputs::GenerationOutputs,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    attempt_history: Option<crate::operation::GenerationAttemptHistory>,
    #[serde(skip)]
    persisted_sha256: Option<String>,
    #[serde(skip)]
    persisted_json: Option<String>,
}

/// Exact normalization and output policy retained by every later stage.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct NormalizedGenerationBinding {
    sha256: String,
    json: String,
    outputs: super::generation_outputs::GenerationOutputs,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    attempt_history: Option<crate::operation::GenerationAttemptHistory>,
}

impl NormalizedGenerationBinding {
    pub(super) fn attempt_history(&self) -> Option<&crate::operation::GenerationAttemptHistory> {
        self.attempt_history.as_ref()
    }
    pub(super) fn receipt(&self) -> (&str, &str) {
        (&self.sha256, &self.json)
    }

    pub(super) fn require_current(&self, library: &Library, operation_id: &str) -> Result<()> {
        let operation =
            OperationCoordinator::resume(operation_id, "verify-generation-history", None);
        crate::operation::GenerationAttemptHistory::require_binding_in(
            self.attempt_history.as_ref(),
            &library.connection()?,
            &operation,
        )?;
        require_normalized_parent(library, operation_id, &self.sha256, &self.json)
    }

    pub(super) fn verify_inputs(
        &self,
        generated: &super::GeneratedInstall,
        contract: &serde_json::Value,
        bootstrap: Option<&BootstrapBinding>,
        library: &Library,
        journal: &LifecycleOperation,
        operation: &OperationCoordinator,
    ) -> Result<()> {
        self.verify_inputs_in_context(
            generated,
            contract,
            bootstrap,
            library,
            NormalizedReadContext::Current(journal),
            operation,
        )
    }

    pub(super) fn verify_closed_configuration_inputs(
        &self,
        generated: &super::GeneratedInstall,
        contract: &serde_json::Value,
        bootstrap: Option<&BootstrapBinding>,
        library: &Library,
        predecessor: &crate::operation::ClosedGenerationPredecessor,
        operation: &OperationCoordinator,
    ) -> Result<()> {
        self.verify_inputs_in_context(
            generated,
            contract,
            bootstrap,
            library,
            NormalizedReadContext::Closed(predecessor),
            operation,
        )
    }

    fn verify_inputs_in_context(
        &self,
        generated: &super::GeneratedInstall,
        contract: &serde_json::Value,
        bootstrap: Option<&BootstrapBinding>,
        library: &Library,
        context: NormalizedReadContext<'_>,
        operation: &OperationCoordinator,
    ) -> Result<()> {
        let journal = match context {
            NormalizedReadContext::Current(journal) => journal,
            NormalizedReadContext::Closed(predecessor) => predecessor.journal(),
        };
        self.require_current(library, operation.operation_id())?;
        let normalized: NormalizedInputWitness = serde_json::from_str(&self.json)?;
        if let NormalizedReadContext::Closed(predecessor) = context {
            normalized.verify_generation_context(library, predecessor, operation)?;
        } else {
            normalized.verify_materialized_context(library, journal, operation)?;
        }
        if normalized.bootstrap.contract() != contract
            || bootstrap.map(|binding| binding.receipt()) != Some(normalized.binding.receipt())
        {
            return Err(PortcoveError::verification(
                "PS1 normalized generation contract changed",
            ));
        }
        let preparation = preparation_from_identity(&normalized.inputs)?;
        normalized.require_generation_recipe(generated, &preparation)?;
        normalized.bootstrap.payload().require_file_bytes(
            std::path::Path::new("game.toml"),
            self.outputs.original_config(),
        )?;
        let original = std::str::from_utf8(self.outputs.original_config())
            .map_err(|_| PortcoveError::verification("PS1 original config encoding changed"))?;
        let expected = super::rewritten_game_discs(original, &preparation.source_paths)?;
        self.outputs.revalidate(
            generated.tree.root(),
            expected.as_bytes(),
            preparation.bios.is_some(),
            operation,
        )?;
        normalized
            .bootstrap
            .payload()
            .require_generation_transition(&generated.tree, &self.outputs, operation)?;
        if let NormalizedReadContext::Closed(predecessor) = context {
            normalized.bootstrap.verify_closed_configuration_archive(
                library,
                predecessor,
                operation,
            )?;
        } else {
            normalized
                .bootstrap
                .verify_archive(library, journal, operation)?;
        }
        if inspect_helper(&normalized.helper_path, operation)? != normalized.helper {
            return Err(PortcoveError::verification("PS1 generation helper changed"));
        }
        self.require_current(library, operation.operation_id())?;
        operation.checkpoint()
    }
}

fn require_normalized_parent(
    library: &Library,
    operation_id: &str,
    sha: &str,
    json: &str,
) -> Result<()> {
    use sha2::Digest;
    if json.len() > 64 * 1024 * 1024 || hex::encode(sha2::Sha256::digest(json.as_bytes())) != sha {
        return Err(PortcoveError::verification(
            "PS1 generation normalized binding changed",
        ));
    }
    let current: bool = library.connection()?.query_row(
        "SELECT EXISTS(SELECT 1 FROM managed_psx_normalized_inputs WHERE operation_id=?1 AND witness_sha256=?2 AND witness_json=?3)",
        rusqlite::params![operation_id, sha, json], |row| row.get(0),
    )?;
    if !current {
        return Err(PortcoveError::conflict(
            "PS1 generation normalized predecessor changed",
        ));
    }
    Ok(())
}

impl PsxStageWitness for ProvisionalGeneratedInstall {
    fn generation_attempt_history(&self) -> Option<&crate::operation::GenerationAttemptHistory> {
        self.attempt_history.as_ref()
    }
    fn library_id(&self) -> &str {
        self.normalized.library_id()
    }
    fn bootstrap_parent(&self) -> Option<(&str, &str)> {
        self.normalized.bootstrap_parent()
    }
    fn normalized_parent(&self) -> Option<(&str, &str)> {
        Some((&self.normalized_sha256, &self.normalized_json))
    }
    fn parent(&self) -> Result<Option<(&str, String)>> {
        Ok(Some((
            &self.normalized_sha256,
            self.normalized_json.clone(),
        )))
    }
    fn verify(
        &self,
        library: &Library,
        journal: &LifecycleOperation,
        operation: &OperationCoordinator,
    ) -> Result<()> {
        ProvisionalGeneratedInstall::verify(self, library, journal, operation)
    }
    fn record_load(&mut self, sha: String) {
        self.persisted_sha256 = Some(sha);
    }
    fn record_load_json(&mut self, json: String) {
        self.persisted_json = Some(json);
    }
}

impl ProvisionalGeneratedInstall {
    #[cfg(test)]
    pub(super) fn retain_attempt_history(
        &mut self,
        history: crate::operation::GenerationAttemptHistory,
    ) {
        self.attempt_history = Some(history);
    }
    pub(crate) fn artifact(&self) -> &crate::ArtifactIdentity {
        self.normalized.artifact()
    }

    pub(crate) fn require_request(
        &self,
        contract: &serde_json::Value,
        preparation: &PsxManagedPreparation,
    ) -> Result<()> {
        self.normalized.require_request(contract, preparation)
    }

    pub(crate) fn loaded_receipt(&self) -> Result<(&str, &str)> {
        Ok((
            self.persisted_sha256.as_deref().ok_or_else(|| {
                PortcoveError::state("PS1 provisional generation was not store-loaded")
            })?,
            self.persisted_json.as_deref().ok_or_else(|| {
                PortcoveError::state("PS1 provisional generation bytes were not store-loaded")
            })?,
        ))
    }

    /// Complete capture may be retained after positive closure, but decoding and
    /// ownership checks grant no generator replay or configure authority.
    pub(crate) fn verify_context(
        &self,
        library: &Library,
        journal: &LifecycleOperation,
        operation: &OperationCoordinator,
    ) -> Result<()> {
        crate::operation::GenerationAttemptHistory::require_binding_in(
            self.attempt_history.as_ref(),
            &library.connection()?,
            operation,
        )?;
        self.normalized
            .verify_materialized_context(library, journal, operation)?;
        require_normalized_parent(
            library,
            operation.operation_id(),
            &self.normalized_sha256,
            &self.normalized_json,
        )?;
        if crate::operation::psx_witness_json(&self.normalized)? != self.normalized_json {
            return Err(PortcoveError::verification(
                "PS1 generation normalized snapshot changed",
            ));
        }
        let preparation = preparation_from_identity(&self.normalized.inputs)?;
        self.normalized
            .require_generation_recipe(&self.generated, &preparation)?;
        if self.generated.tree.root() != self.normalized.bootstrap.payload_root()
            || self.generated.tree.operation_id() != journal.id
            || self.generated.toolchain.root() != fs::canonicalize(&preparation.toolchain_root)?
            || self.generated.toolchain.operation_id() != journal.id
        {
            return Err(PortcoveError::verification(
                "PS1 provisional generation tree custody changed",
            ));
        }
        operation.checkpoint()
    }

    pub(crate) fn into_generation(
        self,
        library: &Library,
        journal: &LifecycleOperation,
    ) -> Result<super::GeneratedInstallWitness> {
        let mut witness = super::GeneratedInstallWitness::new(
            library,
            journal,
            self.normalized.bootstrap.contract().clone(),
            self.generated,
        )?;
        witness.bootstrap = Some(self.normalized.binding);
        witness.normalized = Some(NormalizedGenerationBinding {
            sha256: self.normalized_sha256,
            json: self.normalized_json,
            outputs: self.outputs,
            attempt_history: self.attempt_history,
        });
        Ok(witness)
    }

    pub(crate) fn verify(
        &self,
        library: &Library,
        journal: &LifecycleOperation,
        operation: &OperationCoordinator,
    ) -> Result<()> {
        self.verify_context(library, journal, operation)?;
        use sha2::Digest;
        self.normalized
            .verify_materialized_context(library, journal, operation)?;
        if self.normalized_json.len() > 64 * 1024 * 1024
            || hex::encode(sha2::Sha256::digest(self.normalized_json.as_bytes()))
                != self.normalized_sha256
            || crate::operation::psx_witness_json(&self.normalized)? != self.normalized_json
        {
            return Err(PortcoveError::verification(
                "PS1 generation normalized binding changed",
            ));
        }
        let require_parent = || -> Result<()> {
            let unchanged: bool = library.connection()?.query_row(
                "SELECT EXISTS(SELECT 1 FROM managed_psx_normalized_inputs
                    WHERE operation_id=?1 AND witness_sha256=?2 AND witness_json=?3)",
                rusqlite::params![
                    operation.operation_id(),
                    self.normalized_sha256,
                    self.normalized_json
                ],
                |row| row.get(0),
            )?;
            if !unchanged {
                return Err(PortcoveError::conflict(
                    "PS1 generation normalized predecessor changed",
                ));
            }
            operation.checkpoint()
        };
        require_parent()?;
        let preparation = preparation_from_identity(&self.normalized.inputs)?;
        self.normalized
            .require_generation_recipe(&self.generated, &preparation)?;
        if self.generated.inputs != self.normalized.inputs
            || self.generated.normalized_disc != self.normalized.disc
        {
            return Err(PortcoveError::verification(
                "PS1 generation retained input inventory changed",
            ));
        }
        super::verification::joined_pair(
            || {
                self.normalized
                    .bootstrap
                    .verify_archive(library, journal, operation)?;
                verify_sources(&preparation, operation)?;
                if inspect_helper(&self.normalized.helper_path, operation)?
                    != self.normalized.helper
                {
                    return Err(PortcoveError::verification("PS1 generation helper changed"));
                }
                self.normalized
                    .disc
                    .verify(self.normalized.disc.root(), operation)
            },
            || {
                let platform = crate::Platform::current()?;
                if !super::validate_toolchain_with_checkpoint(
                    &preparation.toolchain_root,
                    platform,
                    super::toolchain_artifact(platform)?,
                    || operation.checkpoint(),
                )? {
                    return Err(PortcoveError::verification(
                        "PS1 generation toolchain changed",
                    ));
                }
                self.generated
                    .toolchain
                    .verify(&preparation.toolchain_root, operation)?;
                self.generated
                    .tree
                    .verify(self.normalized.bootstrap.payload_root(), operation)?;
                if let (Some(bios), Some(staged)) = (&preparation.bios, &self.generated.staged_bios)
                {
                    verify_generated_bios(staged, bios, operation)?;
                }
                Ok(())
            },
        )?;
        self.normalized.bootstrap.payload().require_file_bytes(
            std::path::Path::new("game.toml"),
            self.outputs.original_config(),
        )?;
        let original = std::str::from_utf8(self.outputs.original_config())
            .map_err(|_| PortcoveError::verification("PS1 original config encoding changed"))?;
        let expected = super::rewritten_game_discs(original, &preparation.source_paths)?;
        self.outputs.revalidate(
            self.generated.tree.root(),
            expected.as_bytes(),
            preparation.bios.is_some(),
            operation,
        )?;
        self.normalized
            .bootstrap
            .payload()
            .require_generation_transition(&self.generated.tree, &self.outputs, operation)?;
        self.normalized
            .disc
            .verify_capture_fence(self.normalized.disc.root(), operation)?;
        self.generated
            .toolchain
            .verify_capture_fence(&preparation.toolchain_root, operation)?;
        self.generated
            .tree
            .verify_capture_fence(self.normalized.bootstrap.payload_root(), operation)?;
        require_parent()?;
        self.normalized
            .verify_materialized_context(library, journal, operation)
    }
}

impl NormalizedInputWitness {
    #[cfg(feature = "qualification-fixtures")]
    pub(crate) fn acquired_contract(&self) -> &serde_json::Value {
        self.bootstrap.contract()
    }

    #[cfg(test)]
    pub(super) fn inert_generated_fixture(
        self,
        preparation: &PsxManagedPreparation,
        operation: &OperationCoordinator,
    ) -> Result<ProvisionalGeneratedInstall> {
        let root = self.bootstrap.payload_root();
        let original = crate::path::read_bounded_regular(&root.join("game.toml"), 1024 * 1024)?;
        let expected = super::rewritten_game_discs(
            std::str::from_utf8(&original).unwrap(),
            &preparation.source_paths,
        )?;
        let outputs = super::generation_outputs::GenerationOutputs::inspect(
            root,
            expected.as_bytes(),
            false,
            operation,
        )?;
        for relative in outputs.required_files() {
            fs::create_dir_all(root.join(relative).parent().unwrap())?;
            fs::write(
                root.join(relative),
                "inert generated output; no upstream tool executed",
            )?;
        }
        crate::durability::write_bytes_atomically(
            &root.join("game.toml"),
            expected.as_bytes(),
            true,
        )?;
        let (sha, json) = self.loaded_receipt()?;
        let (normalized_sha256, normalized_json) = (sha.to_owned(), json.to_owned());
        let generated = super::GeneratedInstall {
            tree: GeneratedTree::capture_normalized_generation(root, operation, true)?,
            toolchain: GeneratedTree::capture(&preparation.toolchain_root, operation, true)?,
            normalized_disc: self.disc.clone(),
            inputs: self.inputs.clone(),
            generation_arguments: super::generation_arguments(
                &root.join("game.toml"),
                root,
                &self.cue,
                None,
            )?,
            staged_bios: None,
        };
        Ok(ProvisionalGeneratedInstall {
            normalized: self,
            normalized_sha256,
            normalized_json,
            generated,
            outputs,
            attempt_history: None,
            persisted_sha256: None,
            persisted_json: None,
        })
    }

    pub(super) fn require_generation_recipe(
        &self,
        generated: &super::GeneratedInstall,
        preparation: &PsxManagedPreparation,
    ) -> Result<()> {
        let root = self.bootstrap.payload_root();
        let arguments = super::generation_arguments(
            &root.join("game.toml"),
            root,
            &self.cue,
            preparation.bios.as_ref().map(|bios| bios.path.as_path()),
        )?;
        let staged_bios = preparation
            .bios
            .as_ref()
            .map(|_| super::staged_bios_path(root))
            .transpose()?;
        if generated.generation_arguments != arguments
            || generated.staged_bios != staged_bios
            || generated.inputs != self.inputs
            || generated.normalized_disc != self.disc
        {
            return Err(PortcoveError::verification(
                "PS1 retained generation recipe changed",
            ));
        }
        Ok(())
    }

    pub(crate) fn generate(
        decoded: crate::operation::UnverifiedGenerationInputs,
        library: &Library,
        prior: &LifecycleOperation,
        worker: &LifecycleOperation,
        preparation: &PsxManagedPreparation,
        operation: &OperationCoordinator,
    ) -> (Result<ProvisionalGeneratedInstall>, bool) {
        let mut quiesced = true;
        let result = (|| {
            decoded.require_owned_worker(library, prior, worker, operation)?;
            let (decoded, toolchain) = super::verification::joined_pair(
                || decoded.verify_for_generation(library, prior, worker, operation),
                || {
                    let platform = crate::Platform::current()?;
                    if !super::validate_toolchain_with_checkpoint(
                        &preparation.toolchain_root,
                        platform,
                        super::toolchain_artifact(platform)?,
                        || operation.checkpoint(),
                    )? {
                        return Err(PortcoveError::verification(
                            "PS1 generation requires pinned toolchain",
                        ));
                    }
                    GeneratedTree::capture(&preparation.toolchain_root, operation, true)
                },
            )?;
            let normalized = decoded.witness();
            normalized.bootstrap.require_preparation(preparation)?;
            if normalized.inputs != preparation_identity(preparation)? {
                return Err(PortcoveError::conflict(
                    "PS1 normalized generation request changed",
                ));
            }
            normalized
                .bootstrap
                .payload()
                .verify_capture_fence(normalized.bootstrap.payload_root(), operation)?;
            normalized
                .disc
                .verify_capture_fence(normalized.disc.root(), operation)?;
            toolchain.verify_capture_fence(&preparation.toolchain_root, operation)?;
            let root = normalized.bootstrap.payload_root();
            let config = root.join("game.toml");
            let original = crate::path::read_bounded_regular(&config, 1024 * 1024)?;
            normalized
                .bootstrap
                .payload()
                .require_file_bytes(std::path::Path::new("game.toml"), &original)?;
            let body = std::str::from_utf8(&original)
                .map_err(|_| PortcoveError::verification("PS1 config encoding refused"))?;
            let expected = super::rewritten_game_discs(body, &preparation.source_paths)?;
            let outputs = super::generation_outputs::GenerationOutputs::inspect(
                root,
                expected.as_bytes(),
                preparation.bios.is_some(),
                operation,
            )?;
            let arguments = super::generation_arguments(
                &config,
                root,
                &normalized.cue,
                preparation.bios.as_ref().map(|bios| bios.path.as_path()),
            )?;
            let python = super::toolchain_python(&preparation.toolchain_root)?;
            let (normalized_sha256, normalized_json) = normalized.loaded_receipt()?;
            let normalized_sha256 = normalized_sha256.to_owned();
            let normalized_json = normalized_json.to_owned();
            // No CHD helper or replacement normalized workspace is involved.
            // The fixed packaged CLI still owns its declared boot/disc setup.
            decoded.require_owned_worker(library, prior, worker, operation)?;
            super::run_cli(
                &python,
                &root.join("psxrecomp/psxrecomp_cli.py"),
                root,
                &preparation.toolchain_root,
                arguments.clone(),
                operation,
                &mut quiesced,
            )?;
            if crate::path::read_bounded_regular(&config, 1024 * 1024)? != original {
                return Err(PortcoveError::verification(
                    "PS1 generator changed Core-owned config",
                ));
            }
            operation.checkpoint()?;
            crate::path::refuse_symlink_ancestors(&config)?;
            crate::durability::write_bytes_atomically(&config, expected.as_bytes(), true)?;
            let tree = GeneratedTree::capture_normalized_generation(root, operation, quiesced)?;
            normalized
                .bootstrap
                .payload()
                .require_generation_transition(&tree, &outputs, operation)?;
            let staged_bios = preparation
                .bios
                .as_ref()
                .map(|_| super::staged_bios_path(root))
                .transpose()?;
            let attempt_history = Some(decoded.attempt_history());
            let normalized = decoded.into_witness();
            let generated = super::GeneratedInstall {
                tree,
                toolchain,
                normalized_disc: normalized.disc.clone(),
                inputs: normalized.inputs.clone(),
                generation_arguments: arguments,
                staged_bios,
            };
            Ok(ProvisionalGeneratedInstall {
                normalized,
                normalized_sha256,
                normalized_json,
                generated,
                outputs,
                attempt_history,
                persisted_sha256: None,
                persisted_json: None,
            })
        })();
        (result, quiesced)
    }

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
        self.bootstrap.verify_context(library, journal, operation)?;
        self.require_materialized_binding(library, journal, operation)
    }

    pub(crate) fn verify_generation_context(
        &self,
        library: &Library,
        predecessor: &crate::operation::ClosedGenerationPredecessor,
        operation: &OperationCoordinator,
    ) -> Result<()> {
        self.bootstrap
            .verify_generation_context(library, predecessor, operation)?;
        self.require_materialized_binding(library, predecessor.journal(), operation)
    }

    pub(crate) fn verify_generation_predecessor(
        &self,
        library: &Library,
        predecessor: &crate::operation::ClosedGenerationPredecessor,
        operation: &OperationCoordinator,
    ) -> Result<()> {
        self.verify_generation_context(library, predecessor, operation)?;
        self.bootstrap
            .verify_generation_predecessor(library, predecessor, operation)?;
        let preparation = preparation_from_identity(&self.inputs)?;
        verify_sources(&preparation, operation)?;
        if inspect_helper(&self.helper_path, operation)? != self.helper {
            return Err(PortcoveError::verification(
                "PS1 normalized input helper changed",
            ));
        }
        self.disc.verify(self.disc.root(), operation)
    }

    fn require_materialized_binding(
        &self,
        library: &Library,
        journal: &LifecycleOperation,
        operation: &OperationCoordinator,
    ) -> Result<()> {
        self.binding
            .require_current(library, operation.operation_id())?;
        require_bound_bootstrap(&self.bootstrap, &self.binding)?;
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

pub(super) fn verify_generated_bios(
    path: &std::path::Path,
    bios: &crate::SourceRecord,
    operation: &OperationCoordinator,
) -> Result<()> {
    crate::path::refuse_symlink_ancestors(path)?;
    let canonical = fs::canonicalize(path)?;
    let captured =
        crate::external_runtime::hash_stable_file(&canonical, bios.storage_size, &|| {
            operation.checkpoint()
        })?;
    if captured.size() != bios.storage_size || captured.sha256 != bios.storage_sha256 {
        return Err(PortcoveError::verification(
            "PS1 generated retail BIOS differs from bound source",
        ));
    }
    operation.checkpoint()
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
