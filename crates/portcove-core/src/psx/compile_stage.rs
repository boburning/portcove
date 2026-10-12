//! Joined, bounded compile output. Durable admission belongs to OperationStore;
//! this private primitive cannot publish an installation or grant a retry.
use super::*;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CompiledInstall {
    configuration: ConfiguredInstallWitness,
    configuration_sha256: String,
    tree: stage::GeneratedTree,
    completed_batches: usize,
}

impl PsxStageWitness for CompiledInstall {
    fn ancestor(&self) -> Result<Option<(&str, String)>> {
        self.configuration.parent()
    }
    fn library_id(&self) -> &str {
        &self.configuration.generation.library_id
    }
    fn parent(&self) -> Result<Option<(&str, String)>> {
        Ok(Some((
            &self.configuration_sha256,
            crate::operation::psx_witness_json(&self.configuration)?,
        )))
    }
    fn verify(
        &self,
        library: &Library,
        journal: &crate::operation::LifecycleOperation,
        operation: &OperationCoordinator,
    ) -> Result<()> {
        if self.completed_batches != 1 {
            return Err(PortcoveError::verification(
                "PS1 first compile checkpoint cursor changed",
            ));
        }
        self.configuration
            .generation
            .verify_inputs(library, journal, operation)?;
        let root = self.tree.root();
        let preparation =
            preparation_from_identity(&self.configuration.generation.generated.inputs)?;
        if self.configuration.configured.arguments
            != configure_arguments(
                root,
                &root.join("build-portcove"),
                &preparation.toolchain_root,
            )?
            || self.configuration.configured.compile_plan
                != compile_plan::derive(root, &preparation.executable_basename, operation)?
            || self
                .configuration
                .configured
                .tree
                .configured_transition(root, operation, true)?
                != self.tree
        {
            return Err(PortcoveError::verification("PS1 compiled stage changed"));
        }
        self.configuration.configured.compile_plan.batch(0)?;
        self.tree.verify(root, operation)
    }
}

impl CompiledInstall {
    fn seal_first(
        configuration: ConfiguredInstallWitness,
        operation: &OperationCoordinator,
        quiesced: bool,
        remaining: usize,
    ) -> Result<Self> {
        let configuration_sha256 = configuration.persisted_sha256.clone().ok_or_else(|| {
            PortcoveError::state("PS1 compilation requires store-loaded configuration")
        })?;
        if remaining != 0 {
            return Err(PortcoveError::verification(
                "PS1 compile chunk still has pending work",
            ));
        }
        configuration.configured.compile_plan.batch(0)?;
        let root = configuration.configured.tree.root();
        let preparation = preparation_from_identity(&configuration.generation.generated.inputs)?;
        let tree = configuration
            .configured
            .tree
            .configured_transition(root, operation, quiesced)?;
        if configuration.configured.compile_plan
            != compile_plan::derive(root, &preparation.executable_basename, operation)?
        {
            return Err(PortcoveError::verification("PS1 compile graph changed"));
        }
        verify_inputs(&configuration, &preparation, operation)?;
        tree.verify(root, operation)?;
        Ok(Self {
            configuration,
            configuration_sha256,
            tree,
            completed_batches: 1,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::operation::OperationStore;

    fn fixture() -> (
        tempfile::TempDir,
        Library,
        OperationCoordinator,
        crate::operation::LifecycleOperation,
        ConfiguredInstallWitness,
    ) {
        let temporary = tempfile::tempdir().unwrap();
        let (library, operation, journal, configured) =
            super::super::tests::configuration_witness_fixture(temporary.path());
        let store = OperationStore::new(library.clone());
        store
            .commit_psx_configuration(&journal, &configured, &operation)
            .unwrap();
        let configured = store.psx_configuration(&operation).unwrap();
        (temporary, library, operation, journal, configured)
    }

    #[test]
    fn compile_checkpoint_retains_configured_parent_and_binds_completed_tree() {
        let (_temporary, library, operation, journal, configured) = fixture();
        let build = configured.configured.tree.root().join("build-portcove");
        fs::write(
            build.join("inert.o"),
            "inert compiled output; no native execution",
        )
        .unwrap();
        let compiled = CompiledInstall::seal_first(configured, &operation, true, 0).unwrap();
        let store = OperationStore::new(library.clone());
        store
            .commit_psx_compilation(&journal, &compiled, &operation)
            .unwrap();
        crate::PortcoveService::new(library.clone()).unwrap();
        assert!(store.psx_compilation(&operation).is_ok());
        // The original configured inventory remains immutable, not silently updated.
        assert!(store.psx_configuration(&operation).is_err());
        assert!(library.all_installs().unwrap().is_empty());
        fs::write(build.join("inert.o"), "changed completed output").unwrap();
        assert!(store.psx_compilation(&operation).is_err());
    }

    #[test]
    fn compile_checkpoint_refuses_pending_work() {
        let (_temporary, _library, operation, _journal, configured) = fixture();
        assert!(CompiledInstall::seal_first(configured, &operation, true, 1).is_err());
    }
    #[test]
    fn compile_checkpoint_refuses_uncertain_closure() {
        let (_temporary, _library, operation, _journal, configured) = fixture();
        assert!(CompiledInstall::seal_first(configured, &operation, false, 0).is_err());
    }
    #[test]
    fn compile_checkpoint_refuses_changed_graph() {
        let (_temporary, _library, operation, _journal, configured) = fixture();
        fs::write(
            configured
                .configured
                .tree
                .root()
                .join("build-portcove/CMakeFiles/rules.ninja"),
            "rule LINK\n  command = changed\n",
        )
        .unwrap();
        assert!(CompiledInstall::seal_first(configured, &operation, true, 0).is_err());
    }

    #[test]
    fn compile_checkpoint_fences_original_generation_custody() {
        let (_temporary, library, operation, journal, configured) = fixture();
        let compiled = CompiledInstall::seal_first(configured, &operation, true, 0).unwrap();
        let store = OperationStore::new(library.clone());
        store
            .commit_psx_compilation(&journal, &compiled, &operation)
            .unwrap();
        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE managed_psx_generation SET witness_sha256=?1",
                ["0".repeat(64)],
            )
            .unwrap();
        assert!(store.psx_compilation(&operation).is_err());
        assert!(
            store
                .commit_psx_compilation(&journal, &compiled, &operation)
                .is_err()
        );
    }

    #[test]
    fn compile_checkpoint_refuses_generation_drift_at_final_fence() {
        let (_temporary, library, operation, journal, configured) = fixture();
        let compiled = CompiledInstall::seal_first(configured, &operation, true, 0).unwrap();
        let store = OperationStore::new(library.clone());
        store
            .commit_psx_compilation(&journal, &compiled, &operation)
            .unwrap();
        assert!(store.has_psx_compilation(&operation).unwrap());
        let result = store.psx_compilation_before_fence(&operation, || {
            library.connection()?.execute(
                "UPDATE managed_psx_generation SET witness_sha256=?1",
                ["0".repeat(64)],
            )?;
            Ok(())
        });
        assert!(result.is_err());
    }

    #[test]
    fn compile_checkpoint_refuses_unloaded_configuration_before_native_dispatch() {
        let (_temporary, _library, operation, _journal, configured) = fixture();
        let preparation =
            preparation_from_identity(&configured.generation.generated.inputs).unwrap();
        let reconstructed: ConfiguredInstallWitness =
            serde_json::from_slice(&serde_json::to_vec(&configured).unwrap()).unwrap();
        let (result, quiesced) = reconstructed.compile_first_batch(&preparation, &operation);
        assert!(result.is_err());
        assert!(quiesced);
    }

    #[test]
    fn compile_checkpoint_refuses_parent_drift_and_cascades_with_custody() {
        let (_temporary, library, operation, journal, configured) = fixture();
        let compiled = CompiledInstall::seal_first(configured, &operation, true, 0).unwrap();
        let store = OperationStore::new(library.clone());
        store
            .commit_psx_compilation(&journal, &compiled, &operation)
            .unwrap();
        let connection = library.connection().unwrap();
        connection
            .execute(
                "UPDATE managed_psx_configuration SET witness_sha256=?1",
                ["0".repeat(64)],
            )
            .unwrap();
        assert!(store.psx_compilation(&operation).is_err());
        store.remove(operation.operation_id()).unwrap();
        let count: i64 = connection
            .query_row("SELECT count(*) FROM managed_psx_compilation", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);
    }
}

fn verify_inputs(
    configuration: &ConfiguredInstallWitness,
    preparation: &PsxManagedPreparation,
    operation: &OperationCoordinator,
) -> Result<()> {
    if configuration.generation.generated.inputs != preparation_identity(preparation)? {
        return Err(PortcoveError::verification("PS1 compile inputs changed"));
    }
    configuration
        .generation
        .generated
        .toolchain
        .verify(&preparation.toolchain_root, operation)?;
    configuration.generation.generated.normalized_disc.verify(
        configuration.generation.generated.normalized_disc.root(),
        operation,
    )?;
    crate::adapter::verify_source_storage_identity(&preparation.source, "PS1 source")?;
    if let Some(bios) = &preparation.bios {
        verify_raw_bios(bios, &|| operation.checkpoint())?;
    }
    Ok(())
}

impl ConfiguredInstallWitness {
    pub(crate) fn compile_first_batch(
        self,
        preparation: &PsxManagedPreparation,
        operation: &OperationCoordinator,
    ) -> (Result<CompiledInstall>, bool) {
        let mut quiesced = true;
        let result = (|| {
            if self.persisted_sha256.is_none() {
                return Err(PortcoveError::state(
                    "PS1 compilation requires store-loaded configuration",
                ));
            }
            let root = self.configured.tree.root();
            self.configured.tree.verify(root, operation)?;
            verify_inputs(&self, preparation, operation)?;
            if self.configured.compile_plan
                != compile_plan::derive(root, &preparation.executable_basename, operation)?
            {
                return Err(PortcoveError::verification("PS1 compile graph changed"));
            }
            let targets = self.configured.compile_plan.batch(0)?;
            let ninja = platform_executable(&preparation.toolchain_root.join("bin"), "ninja");
            let arguments = |dry_run| pending::arguments(targets, dry_run);
            let before = capture_pinned_builder(
                &ninja,
                root,
                &preparation.toolchain_root,
                arguments(true),
                operation,
                &mut quiesced,
                true,
            )?;
            let pending = pending::inspect(&before, quiesced)?;
            // The dry run is observational. Recheck its entire input tree before
            // dispatch, including the graph used to choose this finite closure.
            self.configured.tree.verify(root, operation)?;
            verify_inputs(&self, preparation, operation)?;
            if pending.count > 0 {
                capture_pinned_builder(
                    &ninja,
                    root,
                    &preparation.toolchain_root,
                    arguments(false),
                    operation,
                    &mut quiesced,
                    true,
                )?;
            }
            let after = capture_pinned_builder(
                &ninja,
                root,
                &preparation.toolchain_root,
                arguments(true),
                operation,
                &mut quiesced,
                true,
            )?;
            let remaining = pending::inspect(&after, quiesced)?;
            CompiledInstall::seal_first(self, operation, quiesced, remaining.count)
        })();
        (result, quiesced)
    }
}
