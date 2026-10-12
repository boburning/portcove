//! Joined, bounded compile output. Durable admission belongs to OperationStore;
//! this private primitive cannot publish an installation or grant a retry.
use super::*;

/// Joined private packaging result; it cannot publish or bypass the installer.
pub(crate) struct FinalizedInstall {
    compilation: CompiledInstall,
    tree: stage::GeneratedTree,
    retained_inputs: stage::GeneratedTree,
}

impl FinalizedInstall {
    pub(crate) fn compilation(&self) -> &CompiledInstall {
        &self.compilation
    }
    pub(crate) fn seal_manifest(&mut self, operation: &OperationCoordinator) -> Result<()> {
        self.tree = self.tree.manifest_transition(operation)?;
        self.retained_inputs
            .verify(self.retained_inputs.root(), operation)
    }
    pub(crate) fn verify(
        &self,
        library: &Library,
        journal: &crate::operation::LifecycleOperation,
        operation: &OperationCoordinator,
    ) -> Result<()> {
        self.compilation
            .configuration
            .generation
            .verify_inputs(library, journal, operation)?;
        let preparation =
            preparation_from_identity(&self.compilation.configuration.generation.generated.inputs)?;
        verify_inputs(&self.compilation.configuration, &preparation, operation)?;
        if self.compilation.configuration.configured.compile_plan
            != compile_plan::derive(
                self.tree.root(),
                &preparation.executable_basename,
                operation,
            )?
        {
            return Err(PortcoveError::verification("PS1 finalized graph changed"));
        }
        self.tree.verify(self.tree.root(), operation)?;
        self.retained_inputs
            .verify(self.retained_inputs.root(), operation)
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CompiledInstall {
    configuration: ConfiguredInstallWitness,
    configuration_sha256: String,
    tree: stage::GeneratedTree,
    completed_batches: usize,
    #[serde(default = "crate::operation::psx_empty_history_digest")]
    history_sha256: String,
    #[serde(skip)]
    persisted_json: Option<String>,
    #[serde(skip)]
    persisted_sha256: Option<String>,
    #[serde(skip)]
    persisted_history_sha256: Option<String>,
    #[serde(skip)]
    predecessor: Option<(String, String, usize, String)>,
}

impl PsxStageWitness for CompiledInstall {
    fn bootstrap_parent(&self) -> Option<(&str, &str)> {
        self.configuration.bootstrap_parent()
    }
    fn compile_history_identity(&self) -> Option<&str> {
        Some(&self.history_sha256)
    }
    fn record_load_json(&mut self, json: String) {
        self.persisted_json = Some(json);
    }
    fn record_compile_history(&mut self, sha256: String) {
        self.persisted_history_sha256 = Some(sha256);
    }
    fn retained_compile_batches(&self) -> Option<usize> {
        Some(self.completed_batches)
    }
    fn record_load(&mut self, sha256: String) {
        self.persisted_sha256 = Some(sha256);
    }
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
        if self.completed_batches == 0
            || self.completed_batches > self.configuration.configured.compile_plan.batch_count()
        {
            return Err(PortcoveError::verification(
                "PS1 compile checkpoint cursor is outside the sealed plan",
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
    pub(crate) fn require_complete(&self) -> Result<()> {
        if self.persisted_sha256.is_none()
            || self.persisted_json.is_none()
            || self.persisted_history_sha256.is_none()
        {
            return Err(PortcoveError::state(
                "PS1 finalization requires store-loaded compilation",
            ));
        }
        if self.completed_batches == 0
            || self.completed_batches != self.configuration.configured.compile_plan.batch_count()
        {
            return Err(PortcoveError::state(
                "PS1 finalization requires every compile batch",
            ));
        }
        Ok(())
    }

    pub(crate) fn require_finalizable(&self, preparation: &PsxManagedPreparation) -> Result<()> {
        self.require_complete()?;
        if preparation.runtime_source_directory.is_some() {
            return Err(PortcoveError::unsupported(
                "bounded multi-disc runtime extraction requires a separate supervised stage",
            ));
        }
        Ok(())
    }

    pub(crate) fn publication_receipt(&self) -> Result<(&str, &str, &str)> {
        self.require_complete()?;
        Ok((
            self.persisted_sha256
                .as_deref()
                .ok_or_else(|| PortcoveError::state("PS1 loaded digest missing"))?,
            self.persisted_json
                .as_deref()
                .ok_or_else(|| PortcoveError::state("PS1 loaded bytes missing"))?,
            self.persisted_history_sha256
                .as_deref()
                .ok_or_else(|| PortcoveError::state("PS1 loaded history missing"))?,
        ))
    }

    pub(crate) fn finalize(
        self,
        preparation: &PsxManagedPreparation,
        operation: &OperationCoordinator,
    ) -> (Result<FinalizedInstall>, bool) {
        let mut quiesced = true;
        let result = (|| {
            self.require_finalizable(preparation)?;
            self.tree.verify(self.tree.root(), operation)?;
            verify_inputs(&self.configuration, preparation, operation)?;
            let targets = vec![
                self.configuration
                    .configured
                    .compile_plan
                    .runtime_target()
                    .to_owned(),
            ];
            let ninja = platform_executable(&preparation.toolchain_root.join("bin"), "ninja");
            let observed = capture_pinned_builder(
                &ninja,
                self.tree.root(),
                &preparation.toolchain_root,
                pending::arguments(&targets, true),
                operation,
                &mut quiesced,
                true,
            )?;
            let pending = pending::inspect(&observed, quiesced)?;
            self.finish_completed(preparation, operation, quiesced, pending.count)
        })();
        (result, quiesced)
    }

    fn finish_completed(
        self,
        preparation: &PsxManagedPreparation,
        operation: &OperationCoordinator,
        quiesced: bool,
        pending: usize,
    ) -> Result<FinalizedInstall> {
        self.require_finalizable(preparation)?;
        if !quiesced || pending != 0 {
            return Err(PortcoveError::verification(
                "PS1 finalization requires complete zero-pending runtime and positive closure",
            ));
        }
        let root = self.tree.root();
        self.tree.verify(root, operation)?;
        verify_inputs(&self.configuration, preparation, operation)?;
        if self.configuration.configured.compile_plan
            != compile_plan::derive(root, &preparation.executable_basename, operation)?
        {
            return Err(PortcoveError::verification("PS1 completion graph changed"));
        }
        let marker = root.join(".portcove-managed.json");
        let retained = root
            .parent()
            .ok_or_else(|| PortcoveError::state("PS1 payload owner missing"))?
            .join("finalization-inputs");
        if fs::symlink_metadata(&marker).is_ok()
            || fs::symlink_metadata(&retained).is_ok()
            || fs::symlink_metadata(root.join(".portcove-manifest.json")).is_ok()
        {
            return Err(PortcoveError::conflict(
                "PS1 finalization material already exists",
            ));
        }
        let mut closed = quiesced;
        let removed = prepare_built_runtime(
            root,
            preparation,
            operation,
            &mut closed,
            self.configuration.generation.generated.staged_bios.clone(),
            Some(&self.tree),
        )?;
        if !closed {
            return Err(PortcoveError::verification(
                "PS1 finalization lost positive closure",
            ));
        }
        verify_inputs(&self.configuration, preparation, operation)?;
        let removed_paths = removed
            .iter()
            .map(|(source, _)| source.clone())
            .collect::<Vec<_>>();
        let tree = self.tree.finalized_transition(operation, &removed_paths)?;
        let retained_inputs = self.tree.retained_inputs(&retained, &removed, operation)?;
        tree.verify(root, operation)?;
        retained_inputs.verify(&retained, operation)?;
        Ok(FinalizedInstall {
            compilation: self,
            tree,
            retained_inputs,
        })
    }
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
            history_sha256: crate::operation::psx_empty_history_digest(),
            persisted_json: None,
            persisted_sha256: None,
            persisted_history_sha256: None,
            predecessor: None,
        })
    }

    pub(crate) fn completed_batches(&self) -> usize {
        self.completed_batches
    }

    #[cfg(feature = "qualification-fixtures")]
    pub(crate) fn total_batches(&self) -> usize {
        self.configuration.configured.compile_plan.batch_count()
    }
    pub(crate) fn require_next_batch(&self) -> Result<()> {
        self.configuration
            .configured
            .compile_plan
            .batch(self.completed_batches)?;
        Ok(())
    }

    pub(crate) fn artifact(&self) -> Result<crate::ArtifactIdentity> {
        self.configuration.artifact()
    }

    pub(crate) fn require_request(
        &self,
        contract: &serde_json::Value,
        preparation: &PsxManagedPreparation,
    ) -> Result<()> {
        self.configuration.require_request(contract, preparation)
    }

    pub(crate) fn compile_next_batch(
        self,
        preparation: &PsxManagedPreparation,
        operation: &OperationCoordinator,
    ) -> (Result<Self>, bool) {
        let mut quiesced = true;
        let result = (|| {
            if self.persisted_sha256.is_none() {
                return Err(PortcoveError::state(
                    "PS1 continuation requires store-loaded compilation",
                ));
            }
            let remaining = execute_batch(
                &self.configuration,
                &self.tree,
                self.completed_batches,
                preparation,
                operation,
                &mut quiesced,
            )?;
            self.seal_next(operation, quiesced, remaining)
        })();
        (result, quiesced)
    }

    pub(crate) fn predecessor(&self) -> Result<Option<(&str, &str, usize, &str)>> {
        match &self.predecessor {
            Some((sha256, json, cursor, history_sha256))
                if cursor.checked_add(1) == Some(self.completed_batches) =>
            {
                Ok(Some((sha256, json, *cursor, history_sha256)))
            }
            None if self.completed_batches == 1 => Ok(None),
            _ => Err(PortcoveError::state(
                "PS1 compile predecessor is missing or changed",
            )),
        }
    }

    fn seal_next(
        mut self,
        operation: &OperationCoordinator,
        quiesced: bool,
        remaining: usize,
    ) -> Result<Self> {
        let sha256 = self.persisted_sha256.take().ok_or_else(|| {
            PortcoveError::state("PS1 continuation requires store-loaded compilation")
        })?;
        let history_sha256 = self.persisted_history_sha256.take().ok_or_else(|| {
            PortcoveError::state("PS1 continuation requires store-loaded history")
        })?;
        let json = self.persisted_json.take().ok_or_else(|| {
            PortcoveError::state("PS1 continuation requires exact store-loaded bytes")
        })?;
        if remaining != 0 {
            return Err(PortcoveError::verification(
                "PS1 compile chunk still has pending work",
            ));
        }
        self.configuration
            .configured
            .compile_plan
            .batch(self.completed_batches)?;
        let root = self.tree.root();
        let preparation =
            preparation_from_identity(&self.configuration.generation.generated.inputs)?;
        let tree = self.tree.configured_transition(root, operation, quiesced)?;
        if self.configuration.configured.compile_plan
            != compile_plan::derive(root, &preparation.executable_basename, operation)?
        {
            return Err(PortcoveError::verification("PS1 compile graph changed"));
        }
        verify_inputs(&self.configuration, &preparation, operation)?;
        tree.verify(root, operation)?;
        self.history_sha256 = crate::operation::psx_extend_history_digest(
            &history_sha256,
            self.completed_batches,
            &json,
        )?;
        self.predecessor = Some((sha256, json, self.completed_batches, history_sha256));
        self.completed_batches += 1;
        self.tree = tree;
        Ok(self)
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
        fixture_with_batches(false)
    }

    fn fixture_with_batches(
        multiple: bool,
    ) -> (
        tempfile::TempDir,
        Library,
        OperationCoordinator,
        crate::operation::LifecycleOperation,
        ConfiguredInstallWitness,
    ) {
        fixture_with_edges(if multiple { 17 } else { 0 })
    }

    fn fixture_with_edges(
        edges: usize,
    ) -> (
        tempfile::TempDir,
        Library,
        OperationCoordinator,
        crate::operation::LifecycleOperation,
        ConfiguredInstallWitness,
    ) {
        fixture_with_edges_acquired(edges, false)
    }

    fn fixture_with_edges_acquired(
        edges: usize,
        acquired: bool,
    ) -> (
        tempfile::TempDir,
        Library,
        OperationCoordinator,
        crate::operation::LifecycleOperation,
        ConfiguredInstallWitness,
    ) {
        let temporary = tempfile::tempdir().unwrap();
        let (library, operation, journal, mut configured) =
            super::super::tests::configuration_witness_fixture_acquired(temporary.path(), acquired);
        if edges > 0 {
            let root = configured.configured.tree.root();
            let preparation =
                preparation_from_identity(&configured.generation.generated.inputs).unwrap();
            let runtime = platform_executable(Path::new(""), &preparation.executable_basename);
            let mut graph = String::from("include CMakeFiles/rules.ninja\n");
            let outputs: Vec<_> = (0..edges).map(|index| format!("inert-{index}.o")).collect();
            for output in &outputs {
                graph.push_str(&format!("build {output}: LINK\n"));
            }
            graph.push_str(&format!(
                "build {}: LINK {}\nbuild psx-runtime: phony {}\n",
                runtime.display(),
                outputs.join(" "),
                runtime.display()
            ));
            fs::write(root.join("build-portcove/build.ninja"), graph).unwrap();
            configured.configured.compile_plan =
                compile_plan::derive(root, &preparation.executable_basename, &operation).unwrap();
            configured.configured.tree = configured
                .configured
                .tree
                .configured_transition(root, &operation, true)
                .unwrap();
            assert_eq!(
                configured.configured.compile_plan.batch_count(),
                (edges + 1).div_ceil(16)
            );
        }
        let store = OperationStore::new(library.clone());
        store
            .commit_psx_configuration(&journal, &configured, &operation)
            .unwrap();
        let configured = store.psx_configuration(&operation).unwrap();
        (temporary, library, operation, journal, configured)
    }

    #[test]
    fn compile_checkpoint_successor_retains_exact_predecessor_and_refuses_replay() {
        let (_temporary, library, operation, journal, configured) = fixture_with_batches(true);
        let store = OperationStore::new(library.clone());
        let first = CompiledInstall::seal_first(configured, &operation, true, 0).unwrap();
        store
            .commit_psx_compilation(&journal, &first, &operation)
            .unwrap();
        let old_json = crate::operation::psx_witness_json(&first).unwrap();
        let next = store
            .psx_compilation(&operation)
            .unwrap()
            .seal_next(&operation, true, 0)
            .unwrap();
        store
            .commit_psx_compilation(&journal, &next, &operation)
            .unwrap();
        assert_eq!(
            store
                .psx_compilation(&operation)
                .unwrap()
                .completed_batches(),
            2
        );
        let retained: String = library.connection().unwrap().query_row("SELECT witness_json FROM managed_psx_compile_history WHERE operation_id=?1 AND completed_batches=1",[&journal.id],|row|row.get(0)).unwrap();
        assert_eq!(old_json, retained);
        assert!(
            store
                .commit_psx_compilation(&journal, &next, &operation)
                .is_err()
        );
        let loaded = store.psx_compilation(&operation).unwrap();
        let preparation =
            preparation_from_identity(&loaded.configuration.generation.generated.inputs).unwrap();
        let (result, quiesced) = loaded.compile_next_batch(&preparation, &operation);
        assert!(result.is_err());
        assert!(quiesced);
        assert!(library.all_installs().unwrap().is_empty());
    }

    fn completed_fixture() -> (
        tempfile::TempDir,
        Library,
        OperationCoordinator,
        crate::operation::LifecycleOperation,
        CompiledInstall,
        PsxManagedPreparation,
    ) {
        completed_fixture_acquired(false)
    }

    fn completed_fixture_acquired(
        acquired: bool,
    ) -> (
        tempfile::TempDir,
        Library,
        OperationCoordinator,
        crate::operation::LifecycleOperation,
        CompiledInstall,
        PsxManagedPreparation,
    ) {
        let (temporary, library, operation, journal, configured) =
            fixture_with_edges_acquired(0, acquired);
        let preparation =
            preparation_from_identity(&configured.generation.generated.inputs).unwrap();
        fs::write(
            platform_executable(
                &configured.configured.tree.root().join("build-portcove"),
                &preparation.executable_basename,
            ),
            "inert runtime bytes; not an executed game",
        )
        .unwrap();
        let compiled = CompiledInstall::seal_first(configured, &operation, true, 0).unwrap();
        let store = OperationStore::new(library.clone());
        store
            .commit_psx_compilation(&journal, &compiled, &operation)
            .unwrap();
        let compiled = store.psx_compilation(&operation).unwrap();
        (
            temporary,
            library,
            operation,
            journal,
            compiled,
            preparation,
        )
    }

    #[test]
    fn finalization_refuses_incomplete_and_reconstructed_receipts_before_native() {
        let (_temporary, library, operation, journal, configured) = fixture_with_batches(true);
        let preparation =
            preparation_from_identity(&configured.generation.generated.inputs).unwrap();
        let first = CompiledInstall::seal_first(configured, &operation, true, 0).unwrap();
        let store = OperationStore::new(library.clone());
        store
            .commit_psx_compilation(&journal, &first, &operation)
            .unwrap();
        let loaded = store.psx_compilation(&operation).unwrap();
        let (result, closed) = loaded.finalize(&preparation, &operation);
        assert!(result.is_err());
        assert!(closed);
        let reconstructed: CompiledInstall =
            serde_json::from_str(&crate::operation::psx_witness_json(&first).unwrap()).unwrap();
        let (result, closed) = reconstructed.finalize(&preparation, &operation);
        assert!(result.is_err());
        assert!(closed);
        assert!(library.all_installs().unwrap().is_empty());
        assert!(
            !journal
                .paths
                .staging
                .unwrap()
                .join("finalization-inputs")
                .exists()
        );
    }

    #[test]
    fn finalization_refuses_pending_runtime_and_uncertain_closure_without_packaging() {
        let (_temporary, _library, operation, journal, compiled, preparation) = completed_fixture();
        assert!(
            compiled
                .finish_completed(&preparation, &operation, true, 1)
                .is_err()
        );
        assert!(
            !journal
                .paths
                .staging
                .unwrap()
                .join("finalization-inputs")
                .exists()
        );
        let (_temporary, _library, operation, journal, compiled, preparation) = completed_fixture();
        assert!(
            compiled
                .finish_completed(&preparation, &operation, false, 0)
                .is_err()
        );
        assert!(
            !journal
                .paths
                .staging
                .unwrap()
                .join("finalization-inputs")
                .exists()
        );
    }

    #[test]
    fn finalization_refuses_disc_drift_between_precheck_and_archival() {
        let (_temporary, _library, operation, journal, compiled, _preparation) =
            completed_fixture();
        let staging = journal.paths.staging.unwrap();
        compiled
            .tree
            .verify(compiled.tree.root(), &operation)
            .unwrap();
        fs::write(
            staging.join("payload/disc/owned.bin"),
            b"changed after precheck",
        )
        .unwrap();
        let destination = staging.join("retained-disc");
        assert!(
            compiled
                .tree
                .archive_input(Path::new("disc"), &destination, &operation)
                .is_err()
        );
        assert!(!destination.exists());
        assert!(staging.join("payload/disc/owned.bin").is_file());
    }

    #[test]
    fn finalization_refuses_removed_path_reappearance() {
        let (_temporary, _library, operation, journal, compiled, _preparation) =
            completed_fixture();
        let staging = journal.paths.staging.unwrap();
        compiled
            .tree
            .archive_input(
                Path::new("disc"),
                &staging.join("retained-disc"),
                &operation,
            )
            .unwrap();
        fs::create_dir(staging.join("payload/disc")).unwrap();
        fs::write(staging.join("payload/disc/new.bin"), b"reappeared").unwrap();
        assert!(
            compiled
                .tree
                .finalized_transition(&operation, &[PathBuf::from("disc")])
                .is_err()
        );
        assert!(staging.join("retained-disc/owned.bin").is_file());
    }

    #[test]
    fn finalization_refuses_retained_drift_before_inventory_sealing() {
        let (_temporary, _library, operation, journal, compiled, _preparation) =
            completed_fixture();
        let staging = journal.paths.staging.unwrap();
        let retained = staging.join("retained-inputs");
        fs::create_dir(&retained).unwrap();
        compiled
            .tree
            .archive_input(Path::new("disc"), &retained.join("disc"), &operation)
            .unwrap();
        fs::write(retained.join("disc/owned.bin"), b"changed after archive").unwrap();
        assert!(
            compiled
                .tree
                .retained_inputs(
                    &retained,
                    &[(PathBuf::from("disc"), PathBuf::from("disc"))],
                    &operation
                )
                .is_err()
        );
    }

    #[test]
    fn finalization_retains_generation_inputs_and_binds_private_runtime() {
        let (_temporary, library, operation, journal, compiled, preparation) = completed_fixture();
        let finalized = compiled
            .finish_completed(&preparation, &operation, true, 0)
            .unwrap();
        finalized.verify(&library, &journal, &operation).unwrap();
        let staging = journal.paths.staging.unwrap();
        assert_eq!(
            fs::read(staging.join("finalization-inputs/disc/owned.bin")).unwrap(),
            b"inert generated disc copy"
        );
        assert!(!staging.join("payload/disc").exists());
        assert!(staging.join("payload/.portcove-managed.json").is_file());
        assert!(staging.join("payload/build-portcove/game.toml").is_file());
        assert!(library.all_installs().unwrap().is_empty());
        fs::write(
            staging.join("finalization-inputs/disc/owned.bin"),
            "changed retained input",
        )
        .unwrap();
        assert!(
            finalized
                .verify(
                    &library,
                    &crate::operation::OperationStore::new(library.clone())
                        .get(operation.operation_id())
                        .unwrap()
                        .unwrap(),
                    &operation
                )
                .is_err()
        );
    }

    #[test]
    fn finalization_manifest_transition_refuses_runtime_change() {
        let (_temporary, _library, operation, _journal, compiled, preparation) =
            completed_fixture();
        let mut finalized = compiled
            .finish_completed(&preparation, &operation, true, 0)
            .unwrap();
        fs::write(
            finalized.tree.root().join(".portcove-manifest.json"),
            "inert manifest fixture",
        )
        .unwrap();
        fs::write(
            platform_executable(
                &finalized.tree.root().join("build-portcove"),
                &preparation.executable_basename,
            ),
            "changed runtime",
        )
        .unwrap();
        assert!(finalized.seal_manifest(&operation).is_err());
    }

    fn fixture_install(journal: &crate::operation::LifecycleOperation) -> crate::InstallRecord {
        crate::InstallRecord {
            id: journal.id.clone(),
            port_id: journal.port_id.clone(),
            version: "inert".into(),
            path: journal.paths.final_path.clone().unwrap(),
            channel: crate::ReleaseChannel::Stable,
            installed_at: Library::now(),
            verified: true,
            staged: !journal.activate,
            artifact: crate::ArtifactIdentity {
                asset_name: "inert.zip".into(),
                sha256: "1".repeat(64),
                size: 1,
            },
            runtime: None,
            manifest_sha256: "2".repeat(64),
            selected_executable: PathBuf::from("build-portcove/inert.exe"),
        }
    }

    #[test]
    fn finalization_publication_intent_fences_compilation_and_preserves_recovery_record() {
        let (_temporary, library, operation, mut journal, compiled, preparation) =
            completed_fixture();
        let mut finalized = compiled
            .finish_completed(&preparation, &operation, true, 0)
            .unwrap();
        fs::write(
            finalized.tree.root().join(".portcove-manifest.json"),
            "inert manifest; not installed acceptance",
        )
        .unwrap();
        finalized.seal_manifest(&operation).unwrap();
        let store = OperationStore::new(library.clone());
        journal.install = Some(fixture_install(&journal));
        store
            .prepare_psx_publication(&mut journal, &finalized, &operation)
            .unwrap();
        assert_eq!(journal.phase, crate::operation::LifecyclePhase::Prepared);
        let retained = store.get(&journal.id).unwrap().unwrap();
        assert_eq!(retained.phase, crate::operation::LifecyclePhase::Prepared);
        assert!(retained.install.is_some());
        assert!(library.all_installs().unwrap().is_empty());
        assert!(
            store
                .prepare_psx_publication(&mut journal, &finalized, &operation)
                .is_err()
        );
    }

    #[test]
    fn bootstrap_predecessor_propagates_to_compile_and_publication_fence() {
        let (_temporary, library, operation, mut journal, compiled, preparation) =
            completed_fixture_acquired(true);
        assert!(compiled.bootstrap_parent().is_some());
        let mut finalized = compiled
            .finish_completed(&preparation, &operation, true, 0)
            .unwrap();
        fs::write(
            finalized.tree.root().join(".portcove-manifest.json"),
            "inert manifest; no runtime acceptance",
        )
        .unwrap();
        finalized.seal_manifest(&operation).unwrap();
        journal.install = Some(fixture_install(&journal));
        let store = OperationStore::new(library.clone());
        let result = store.prepare_psx_publication_before_fence(&mut journal, &finalized, &operation, || {
            library.connection()?.execute("UPDATE managed_psx_bootstrap SET witness_json=witness_json || ' ' WHERE operation_id=?1", [operation.operation_id()])?;
            Ok(())
        });
        assert!(result.is_err());
        assert_eq!(
            store.get(operation.operation_id()).unwrap().unwrap().phase,
            crate::operation::LifecyclePhase::StagedPreparing
        );
        assert!(library.all_installs().unwrap().is_empty());
    }

    #[test]
    fn finalization_publication_intent_refuses_changed_compilation() {
        let (_temporary, library, operation, mut journal, compiled, preparation) =
            completed_fixture();
        let mut finalized = compiled
            .finish_completed(&preparation, &operation, true, 0)
            .unwrap();
        fs::write(
            finalized.tree.root().join(".portcove-manifest.json"),
            "inert manifest",
        )
        .unwrap();
        finalized.seal_manifest(&operation).unwrap();
        journal.install = Some(fixture_install(&journal));
        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE managed_psx_compilation SET witness_sha256=?1",
                ["0".repeat(64)],
            )
            .unwrap();
        let store = OperationStore::new(library.clone());
        assert!(
            store
                .prepare_psx_publication(&mut journal, &finalized, &operation)
                .is_err()
        );
        assert_eq!(
            store.get(&journal.id).unwrap().unwrap().phase,
            crate::operation::LifecyclePhase::StagedPreparing
        );
    }

    #[test]
    fn compile_checkpoint_successor_refuses_changed_predecessor_atomically() {
        let (_temporary, library, operation, journal, configured) = fixture_with_batches(true);
        let store = OperationStore::new(library.clone());
        let first = CompiledInstall::seal_first(configured, &operation, true, 0).unwrap();
        store
            .commit_psx_compilation(&journal, &first, &operation)
            .unwrap();
        let next = store
            .psx_compilation(&operation)
            .unwrap()
            .seal_next(&operation, true, 0)
            .unwrap();
        let connection = library.connection().unwrap();
        connection
            .execute(
                "UPDATE managed_psx_compilation SET witness_sha256=?1",
                ["0".repeat(64)],
            )
            .unwrap();
        assert!(
            store
                .commit_psx_compilation(&journal, &next, &operation)
                .is_err()
        );
        let count: i64 = connection
            .query_row(
                "SELECT count(*) FROM managed_psx_compile_history",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn compile_checkpoint_successor_requires_load_marker_and_complete_history() {
        let (_temporary, library, operation, journal, configured) = fixture_with_batches(true);
        let store = OperationStore::new(library.clone());
        let first = CompiledInstall::seal_first(configured, &operation, true, 0).unwrap();
        store
            .commit_psx_compilation(&journal, &first, &operation)
            .unwrap();
        let loaded = store.psx_compilation(&operation).unwrap();
        let reconstructed: CompiledInstall =
            serde_json::from_str(&crate::operation::psx_witness_json(&loaded).unwrap()).unwrap();
        let preparation =
            preparation_from_identity(&reconstructed.configuration.generation.generated.inputs)
                .unwrap();
        let (result, quiesced) = reconstructed.compile_next_batch(&preparation, &operation);
        assert!(result.is_err());
        assert!(quiesced);
        let next = loaded.seal_next(&operation, true, 0).unwrap();
        store
            .commit_psx_compilation(&journal, &next, &operation)
            .unwrap();
        library
            .connection()
            .unwrap()
            .execute("DELETE FROM managed_psx_compile_history", [])
            .unwrap();
        assert!(store.psx_compilation(&operation).is_err());
    }

    #[test]
    fn compile_checkpoint_exhaustion_preserves_valid_checkpoint_and_journal() {
        let (_temporary, library, operation, journal, configured) = fixture();
        let store = OperationStore::new(library.clone());
        let first = CompiledInstall::seal_first(configured, &operation, true, 0).unwrap();
        store
            .commit_psx_compilation(&journal, &first, &operation)
            .unwrap();
        let before = format!("{:?}", store.get(&journal.id).unwrap());
        let loaded = store.psx_compilation(&operation).unwrap();
        assert!(loaded.require_next_batch().is_err());
        assert_eq!(format!("{:?}", store.get(&journal.id).unwrap()), before);
        assert!(store.psx_compilation(&operation).is_ok());
        assert!(library.all_installs().unwrap().is_empty());
    }

    #[test]
    fn compile_checkpoint_zero_cursor_is_refused_without_panicking() {
        use sha2::{Digest, Sha256};
        let (_temporary, library, operation, journal, configured) = fixture();
        let store = OperationStore::new(library.clone());
        let first = CompiledInstall::seal_first(configured, &operation, true, 0).unwrap();
        store
            .commit_psx_compilation(&journal, &first, &operation)
            .unwrap();
        let mut json = serde_json::to_value(first).unwrap();
        json["completed_batches"] = serde_json::json!(0);
        let json = serde_json::to_string(&json).unwrap();
        let sha = hex::encode(Sha256::digest(json.as_bytes()));
        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE managed_psx_compilation SET witness_json=?1,witness_sha256=?2",
                rusqlite::params![json, sha],
            )
            .unwrap();
        assert!(store.psx_compilation(&operation).is_err());
    }

    #[test]
    fn compile_checkpoint_history_drift_refuses_successor_before_cursor_change() {
        let (_temporary, library, operation, journal, configured) = fixture_with_edges(33);
        let store = OperationStore::new(library.clone());
        let first = CompiledInstall::seal_first(configured, &operation, true, 0).unwrap();
        store
            .commit_psx_compilation(&journal, &first, &operation)
            .unwrap();
        let second = store
            .psx_compilation(&operation)
            .unwrap()
            .seal_next(&operation, true, 0)
            .unwrap();
        store
            .commit_psx_compilation(&journal, &second, &operation)
            .unwrap();
        let third = store
            .psx_compilation(&operation)
            .unwrap()
            .seal_next(&operation, true, 0)
            .unwrap();
        let connection = library.connection().unwrap();
        connection
            .execute("DELETE FROM managed_psx_compile_history", [])
            .unwrap();
        assert!(
            store
                .commit_psx_compilation(&journal, &third, &operation)
                .is_err()
        );
        let json: String = connection
            .query_row(
                "SELECT witness_json FROM managed_psx_compilation",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let retained: CompiledInstall = serde_json::from_str(&json).unwrap();
        assert_eq!(retained.completed_batches(), 2);
    }

    #[test]
    fn compile_checkpoint_history_byte_drift_is_bound_at_load_and_final_fence() {
        use sha2::{Digest, Sha256};
        let (_temporary, library, operation, journal, configured) = fixture_with_batches(true);
        let store = OperationStore::new(library.clone());
        let first = CompiledInstall::seal_first(configured, &operation, true, 0).unwrap();
        store
            .commit_psx_compilation(&journal, &first, &operation)
            .unwrap();
        let second = store
            .psx_compilation(&operation)
            .unwrap()
            .seal_next(&operation, true, 0)
            .unwrap();
        store
            .commit_psx_compilation(&journal, &second, &operation)
            .unwrap();
        let changed = "retained byte mutation with internally matching digest";
        let changed_sha = hex::encode(Sha256::digest(changed.as_bytes()));
        let result = store.psx_compilation_before_fence(&operation, || {
            library.connection()?.execute(
                "UPDATE managed_psx_compile_history SET witness_json=?1,witness_sha256=?2",
                rusqlite::params![changed, changed_sha],
            )?;
            Ok(())
        });
        assert!(result.is_err());
        assert!(store.psx_compilation(&operation).is_err());
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
            let remaining = execute_batch(
                &self,
                &self.configured.tree,
                0,
                preparation,
                operation,
                &mut quiesced,
            )?;
            CompiledInstall::seal_first(self, operation, quiesced, remaining)
        })();
        (result, quiesced)
    }
}

fn execute_batch(
    configuration: &ConfiguredInstallWitness,
    tree: &stage::GeneratedTree,
    index: usize,
    preparation: &PsxManagedPreparation,
    operation: &OperationCoordinator,
    quiesced: &mut bool,
) -> Result<usize> {
    let root = tree.root();
    tree.verify(root, operation)?;
    verify_inputs(configuration, preparation, operation)?;
    if configuration.configured.compile_plan
        != compile_plan::derive(root, &preparation.executable_basename, operation)?
    {
        return Err(PortcoveError::verification("PS1 compile graph changed"));
    }
    let targets = configuration.configured.compile_plan.batch(index)?;
    let ninja = platform_executable(&preparation.toolchain_root.join("bin"), "ninja");
    let arguments = |dry_run| pending::arguments(targets, dry_run);
    let before = capture_pinned_builder(
        &ninja,
        root,
        &preparation.toolchain_root,
        arguments(true),
        operation,
        quiesced,
        true,
    )?;
    let pending = pending::inspect(&before, *quiesced)?;
    // The dry run is observational. Recheck its entire input tree before
    // dispatch, including the graph used to choose this finite closure.
    tree.verify(root, operation)?;
    verify_inputs(configuration, preparation, operation)?;
    if pending.count > 0 {
        capture_pinned_builder(
            &ninja,
            root,
            &preparation.toolchain_root,
            arguments(false),
            operation,
            quiesced,
            true,
        )?;
    }
    let after = capture_pinned_builder(
        &ninja,
        root,
        &preparation.toolchain_root,
        arguments(true),
        operation,
        quiesced,
        true,
    )?;
    let remaining = pending::inspect(&after, *quiesced)?;
    Ok(remaining.count)
}
