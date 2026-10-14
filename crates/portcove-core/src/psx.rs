use std::{
    fs,
    path::{Path, PathBuf},
};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

mod bootstrap;
pub(crate) use bootstrap::{BootstrapWitness, archive_path as retained_archive_path};
mod generation_outputs;
mod normalized_inputs;
pub(crate) use normalized_inputs::{NormalizedInputWitness, ProvisionalGeneratedInstall};
mod compile_plan;
mod compile_stage;
pub(crate) use compile_stage::{CompiledInstall, FinalizedInstall};
mod pending;
#[cfg(feature = "qualification-fixtures")]
pub(crate) mod qualification_trace;
mod stage;
mod verification;
#[cfg(feature = "qualification-fixtures")]
pub use qualification_trace::qualification_psx_preparation_diagnostics;

use crate::{
    ChildProcessClass, ChildProcessPolicy, Library, OperationCoordinator, OperationEvent,
    OperationResult, Platform, PortcoveError, Result, SourceRecord,
    adapter::hash_file,
    archive::{extract_archive, validate_download_progress, validate_download_size},
};

const TOOLCHAIN_VERSION: &str = "1.0.14";

#[derive(Debug, Clone)]
pub struct PsxManagedPreparation {
    pub source: SourceRecord,
    pub bios: Option<SourceRecord>,
    pub source_paths: Vec<PathBuf>,
    pub runtime_source_directory: Option<PathBuf>,
    pub toolchain_root: PathBuf,
    pub executable_basename: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct GeneratedInstall {
    tree: stage::GeneratedTree,
    toolchain: stage::GeneratedTree,
    normalized_disc: stage::GeneratedTree,
    inputs: Vec<u8>,
    generation_arguments: Vec<String>,
    staged_bios: Option<PathBuf>,
}

/// Private successful configure output. No installation or publication follows
/// merely from possession of this operation-bound inventory.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ConfiguredInstall {
    tree: stage::GeneratedTree,
    arguments: Vec<String>,
    compile_plan: compile_plan::CompilePlan,
}

pub(crate) fn configure_install_stage(
    root: &Path,
    preparation: &PsxManagedPreparation,
    operation: &OperationCoordinator,
    generated: &GeneratedInstall,
) -> (Result<ConfiguredInstall>, bool) {
    let mut quiesced = true;
    let result = configure_install(root, preparation, operation, &mut quiesced, generated);
    (result, quiesced)
}

fn configure_install(
    root: &Path,
    preparation: &PsxManagedPreparation,
    operation: &OperationCoordinator,
    quiesced: &mut bool,
    generated: &GeneratedInstall,
) -> Result<ConfiguredInstall> {
    configure_install_with_recovery(root, preparation, operation, quiesced, generated, false)
}

fn configure_install_with_recovery(
    root: &Path,
    preparation: &PsxManagedPreparation,
    operation: &OperationCoordinator,
    quiesced: &mut bool,
    generated: &GeneratedInstall,
    recovered: bool,
) -> Result<ConfiguredInstall> {
    if generated.inputs != preparation_identity(preparation)? {
        return Err(PortcoveError::verification("PS1 configure inputs changed"));
    }
    if recovered {
        // Only the explicitly started failed-configure worker reaches this
        // branch. Original files remain bound to the immutable sealed receipt.
        generated
            .tree
            .configured_transition(root, operation, true)?;
    } else {
        generated.tree.verify(root, operation)?;
    }
    generated
        .toolchain
        .verify(&preparation.toolchain_root, operation)?;
    generated
        .normalized_disc
        .verify(generated.normalized_disc.root(), operation)?;
    crate::adapter::verify_source_storage_identity(&preparation.source, "PS1 source")?;
    if let Some(bios) = &preparation.bios {
        verify_raw_bios(bios, &|| operation.checkpoint())?;
    }
    PreparationConfiguration::from_preparation(preparation)?;
    let build = root.join("build-portcove");
    // Configuration is admitted only once into a fresh operation-owned tree.
    // Never invoke CMake's relocated-cache deletion or repair another build.
    match fs::symlink_metadata(&build) {
        Ok(_) => {
            return Err(PortcoveError::conflict(
                "PS1 configure build directory already exists",
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let arguments = configure_arguments(root, &build, &preparation.toolchain_root)?;
    let cmake = platform_executable(&preparation.toolchain_root.join("bin"), "cmake");
    run_pinned_builder(
        &cmake,
        root,
        &preparation.toolchain_root,
        arguments.clone(),
        operation,
        quiesced,
    )?;
    generated
        .toolchain
        .verify(&preparation.toolchain_root, operation)?;
    generated
        .normalized_disc
        .verify(generated.normalized_disc.root(), operation)?;
    crate::adapter::verify_source_storage_identity(&preparation.source, "PS1 source")?;
    if let Some(bios) = &preparation.bios {
        verify_raw_bios(bios, &|| operation.checkpoint())?;
    }
    if !build.join("build.ninja").is_file() || !build.join("CMakeCache.txt").is_file() {
        return Err(PortcoveError::install(
            "PS1 configure completed without its Ninja graph and cache",
        ));
    }
    let cache = verify_configure_cache(&build, &preparation.toolchain_root)?;
    let tree = generated
        .tree
        .configured_transition(root, operation, *quiesced)?;
    tree.require_file_bytes(Path::new("build-portcove/CMakeCache.txt"), &cache)?;
    let compile_plan = compile_plan::derive(root, &preparation.executable_basename, operation)?;
    tree.verify(root, operation)?;
    Ok(ConfiguredInstall {
        tree,
        arguments,
        compile_plan,
    })
}

fn builder_path(path: &Path) -> Result<String> {
    #[cfg(windows)]
    if matches!(
        path.components().next(),
        Some(std::path::Component::Prefix(prefix))
            if matches!(prefix.kind(), std::path::Prefix::UNC(_, _) | std::path::Prefix::VerbatimUNC(_, _))
    ) {
        return Err(PortcoveError::unsupported(
            "managed PS1 command-shell builds require a local Windows working directory",
        ));
    }
    crate::path::refuse_symlink_ancestors(path)?;
    crate::adapter::psx_launch_path(path)
}

fn configure_arguments(root: &Path, build: &Path, toolchain: &Path) -> Result<Vec<String>> {
    let bin = toolchain.join("bin");
    let mut arguments = vec![
        "-S".into(),
        // CMake emits command-shell working directories into the Ninja graph.
        // Use the existing identity-checked ordinary Windows spelling there;
        // canonical paths remain the inventory and witness authority.
        builder_path(root)?,
        "-B".into(),
        builder_path(build)?,
        "-G".into(),
        "Ninja".into(),
        format!(
            "-DCMAKE_MAKE_PROGRAM={}",
            builder_path(&platform_executable(&bin, "ninja"))?
        ),
        format!(
            "-DCMAKE_C_COMPILER={}",
            builder_path(&platform_executable(&bin, "clang"))?
        ),
        format!(
            "-DCMAKE_CXX_COMPILER={}",
            builder_path(&platform_executable(&bin, "clang++"))?
        ),
        "-DCMAKE_BUILD_TYPE=Release".into(),
        // The sealed graph is immutable across batches. CMake's always-dirty
        // glob/regeneration preflight otherwise hides target work in Ninja -n.
        "-DCMAKE_SUPPRESS_REGENERATION=ON".into(),
        format!(
            "-DPython3_EXECUTABLE={}",
            builder_path(&toolchain_python(toolchain)?)?
        ),
        "-DPSX_PGO=".into(),
        "-DBPE_FORCE_SETUP_HOST=OFF".into(),
        "-DPSXRECOMP_FORCE_SETUP_HOST=OFF".into(),
        "-DPSXRECOMP_ALLOW_NO_BIOS=OFF".into(),
        "-DPSXRECOMP_REQUIRE_GAME_C=ON".into(),
        "-DPSX_DEBUG_TOOLS=OFF".into(),
        "-DCMAKE_C_COMPILER_LAUNCHER:STRING=".into(),
        "-DCMAKE_CXX_COMPILER_LAUNCHER:STRING=".into(),
    ];
    // Match the SDK's Linux pack sysroot contract; Windows uses pack clang.cfg.
    if cfg!(target_os = "linux") && toolchain.join("sysroot/usr/include").is_dir() {
        arguments.push(format!(
            "-DCMAKE_SYSROOT={}",
            crate::path::unicode(&toolchain.join("sysroot"), "pinned sysroot")?
        ));
        arguments.push("-DOpenGL_GL_PREFERENCE=LEGACY".into());
    }
    for name in ["cmake", "ninja", "clang", "clang++"] {
        let path = platform_executable(&bin, name);
        crate::path::refuse_symlink_ancestors(&path)?;
        if !fs::symlink_metadata(path)?.is_file() {
            return Err(PortcoveError::verification(
                "PS1 configure requires regular pinned tools",
            ));
        }
    }
    Ok(arguments)
}

fn verify_configure_cache(build: &Path, toolchain: &Path) -> Result<Vec<u8>> {
    let cache = crate::external_runtime::read_stable_metadata(
        &build.join("CMakeCache.txt"),
        4 * 1024 * 1024,
    )?;
    let text = std::str::from_utf8(&cache)
        .map_err(|_| PortcoveError::verification("PS1 configuration cache is not UTF-8"))?;
    let expected_python = builder_path(&toolchain_python(toolchain)?)?.replace('\\', "/");
    for (key, expected) in [
        ("CMAKE_SUPPRESS_REGENERATION", "ON"),
        ("Python3_EXECUTABLE", expected_python.as_str()),
    ] {
        let mut values = text.lines().filter_map(|line| {
            let (name, value) = line.split_once('=')?;
            (name.split_once(':')?.0 == key).then_some(value)
        });
        if values.next().map(|value| value.replace('\\', "/")) != Some(expected.to_owned())
            || values.next().is_some()
        {
            return Err(PortcoveError::verification(
                "PS1 configuration did not retain pinned Python and immutable graph policy",
            ));
        }
    }
    Ok(cache)
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct GeneratedInstallWitness {
    schema_version: u32,
    library_root: PathBuf,
    library_id: String,
    port_id: String,
    final_path: Option<PathBuf>,
    activate: bool,
    created_at: i64,
    contract: serde_json::Value,
    generated: GeneratedInstall,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    bootstrap: Option<bootstrap::BootstrapBinding>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    normalized: Option<normalized_inputs::NormalizedGenerationBinding>,
    #[serde(skip)]
    persisted_sha256: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ConfiguredInstallWitness {
    generation: GeneratedInstallWitness,
    generation_sha256: String,
    configured: ConfiguredInstall,
    #[serde(skip)]
    persisted_sha256: Option<String>,
}

/// Private store interface; deserialization alone never admits a stage.
pub(crate) trait PsxStageWitness: Serialize + serde::de::DeserializeOwned {
    fn generation_attempt_history(&self) -> Option<&crate::operation::GenerationAttemptHistory> {
        None
    }
    fn library_id(&self) -> &str;
    fn verify(
        &self,
        library: &Library,
        journal: &crate::operation::LifecycleOperation,
        operation: &OperationCoordinator,
    ) -> Result<()>;
    fn bootstrap_parent(&self) -> Option<(&str, &str)> {
        None
    }
    fn normalized_parent(&self) -> Option<(&str, &str)> {
        None
    }
    fn parent(&self) -> Result<Option<(&str, String)>> {
        Ok(None)
    }
    fn ancestor(&self) -> Result<Option<(&str, String)>> {
        Ok(None)
    }
    fn record_load(&mut self, _sha256: String) {}
    fn retained_compile_batches(&self) -> Option<usize> {
        None
    }
    fn record_compile_history(&mut self, _sha256: String) {}
    fn compile_history_identity(&self) -> Option<&str> {
        None
    }
    fn record_load_json(&mut self, _json: String) {}
}

impl PsxStageWitness for GeneratedInstallWitness {
    fn generation_attempt_history(&self) -> Option<&crate::operation::GenerationAttemptHistory> {
        self.normalized
            .as_ref()
            .and_then(|binding| binding.attempt_history())
    }
    fn normalized_parent(&self) -> Option<(&str, &str)> {
        self.normalized.as_ref().map(|binding| binding.receipt())
    }
    fn bootstrap_parent(&self) -> Option<(&str, &str)> {
        self.bootstrap.as_ref().map(|binding| binding.receipt())
    }
    fn library_id(&self) -> &str {
        &self.library_id
    }
    fn verify(
        &self,
        library: &Library,
        journal: &crate::operation::LifecycleOperation,
        operation: &OperationCoordinator,
    ) -> Result<()> {
        GeneratedInstallWitness::verify(self, library, journal, operation)
    }
    fn record_load(&mut self, sha256: String) {
        self.persisted_sha256 = Some(sha256);
    }
}

impl PsxStageWitness for ConfiguredInstallWitness {
    fn generation_attempt_history(&self) -> Option<&crate::operation::GenerationAttemptHistory> {
        self.generation.generation_attempt_history()
    }
    fn normalized_parent(&self) -> Option<(&str, &str)> {
        self.generation.normalized_parent()
    }
    fn bootstrap_parent(&self) -> Option<(&str, &str)> {
        self.generation.bootstrap_parent()
    }
    fn record_load(&mut self, sha256: String) {
        self.persisted_sha256 = Some(sha256);
    }
    fn library_id(&self) -> &str {
        &self.generation.library_id
    }
    fn parent(&self) -> Result<Option<(&str, String)>> {
        Ok(Some((
            &self.generation_sha256,
            crate::operation::psx_witness_json(&self.generation)?,
        )))
    }
    fn verify(
        &self,
        library: &Library,
        journal: &crate::operation::LifecycleOperation,
        operation: &OperationCoordinator,
    ) -> Result<()> {
        self.generation.verify_inputs(library, journal, operation)?;
        let root = self.generation.generated.tree.root();
        let preparation = preparation_from_identity(&self.generation.generated.inputs)?;
        if self.configured.arguments
            != configure_arguments(
                root,
                &root.join("build-portcove"),
                &preparation.toolchain_root,
            )?
        {
            return Err(PortcoveError::verification("PS1 configure recipe changed"));
        }
        if self.configured.compile_plan
            != compile_plan::derive(root, &preparation.executable_basename, operation)?
        {
            return Err(PortcoveError::verification(
                "PS1 retained compile plan changed",
            ));
        }
        let current = self
            .generation
            .generated
            .tree
            .configured_transition(root, operation, true)?;
        if current != self.configured.tree {
            return Err(PortcoveError::verification(
                "PS1 configured stage identity changed",
            ));
        }
        Ok(())
    }
}

impl ConfiguredInstallWitness {
    pub(crate) fn artifact(&self) -> Result<crate::ArtifactIdentity> {
        self.generation.artifact()
    }
    pub(crate) fn require_request(
        &self,
        contract: &serde_json::Value,
        preparation: &PsxManagedPreparation,
    ) -> Result<()> {
        self.generation.require_request(contract, preparation)
    }
    pub(crate) fn observe_pending(
        self,
        preparation: &PsxManagedPreparation,
        batch: usize,
        operation: &OperationCoordinator,
    ) -> (Result<usize>, bool) {
        let mut quiesced = true;
        let result = (|| {
            if self.persisted_sha256.is_none()
                || self.generation.generated.inputs != preparation_identity(preparation)?
            {
                return Err(PortcoveError::state(
                    "PS1 pending query requires unchanged store-loaded configuration",
                ));
            }
            let root = self.configured.tree.root();
            self.configured.tree.verify(root, operation)?;
            self.generation
                .generated
                .toolchain
                .verify(&preparation.toolchain_root, operation)?;
            self.generation
                .generated
                .normalized_disc
                .verify(self.generation.generated.normalized_disc.root(), operation)?;
            crate::adapter::verify_source_storage_identity(&preparation.source, "PS1 source")?;
            if let Some(bios) = &preparation.bios {
                verify_raw_bios(bios, &|| operation.checkpoint())?;
            }
            let targets = self.configured.compile_plan.batch(batch)?;
            let arguments = pending::arguments(targets, true);
            let capture = capture_pinned_builder(
                &platform_executable(&preparation.toolchain_root.join("bin"), "ninja"),
                root,
                &preparation.toolchain_root,
                arguments,
                operation,
                &mut quiesced,
                true,
            )?;
            let pending = pending::inspect(&capture, quiesced)?;
            self.configured.tree.verify(root, operation)?;
            self.generation
                .generated
                .toolchain
                .verify(&preparation.toolchain_root, operation)?;
            self.generation
                .generated
                .normalized_disc
                .verify(self.generation.generated.normalized_disc.root(), operation)?;
            crate::adapter::verify_source_storage_identity(&preparation.source, "PS1 source")?;
            if let Some(bios) = &preparation.bios {
                verify_raw_bios(bios, &|| operation.checkpoint())?;
            }
            Ok(pending.count)
        })();
        (result, quiesced)
    }
    pub(crate) fn port_id(&self) -> &str {
        self.generation.port_id()
    }
}

impl GeneratedInstallWitness {
    #[cfg(feature = "qualification-fixtures")]
    pub(crate) fn acquired_contract(&self) -> &serde_json::Value {
        &self.contract
    }

    pub(crate) fn with_bootstrap(mut self, binding: bootstrap::BootstrapBinding) -> Self {
        self.bootstrap = Some(binding);
        self
    }
    pub(crate) fn artifact(&self) -> Result<crate::ArtifactIdentity> {
        serde_json::from_value(
            self.contract.get("artifact").cloned().ok_or_else(|| {
                PortcoveError::state("PS1 generation retained artifact is missing")
            })?,
        )
        .map_err(Into::into)
    }
    pub(crate) fn port_id(&self) -> &str {
        &self.port_id
    }

    pub(crate) fn new(
        library: &Library,
        journal: &crate::operation::LifecycleOperation,
        contract: serde_json::Value,
        generated: GeneratedInstall,
    ) -> Result<Self> {
        crate::path::refuse_symlink_ancestors(library.root())?;
        Ok(Self {
            schema_version: 1,
            library_root: fs::canonicalize(library.root())?,
            library_id: library.identity()?,
            port_id: journal.port_id.clone(),
            final_path: journal.paths.final_path.clone(),
            activate: journal.activate,
            created_at: journal.created_at,
            contract,
            generated,
            bootstrap: None,
            normalized: None,
            persisted_sha256: None,
        })
    }

    pub(crate) fn require_request(
        &self,
        contract: &serde_json::Value,
        preparation: &PsxManagedPreparation,
    ) -> Result<()> {
        if &self.contract != contract || self.generated.inputs != preparation_identity(preparation)?
        {
            return Err(PortcoveError::conflict("PS1 continuation request changed"));
        }
        Ok(())
    }

    pub(crate) fn configure(
        self,
        preparation: &PsxManagedPreparation,
        operation: &OperationCoordinator,
    ) -> (Result<ConfiguredInstallWitness>, bool) {
        let Some(generation_sha256) = self.persisted_sha256.clone() else {
            return (
                Err(PortcoveError::state(
                    "PS1 configure requires a store-loaded generation witness",
                )),
                true,
            );
        };
        let (result, quiesced) = configure_install_stage(
            self.generated.tree.root(),
            preparation,
            operation,
            &self.generated,
        );
        (
            result.map(|configured| ConfiguredInstallWitness {
                generation: self,
                generation_sha256,
                configured,
                persisted_sha256: None,
            }),
            quiesced,
        )
    }

    pub(crate) fn require_owner(
        &self,
        library: &Library,
        journal: &crate::operation::LifecycleOperation,
    ) -> Result<()> {
        if journal.last_error.is_some() {
            return Err(PortcoveError::state(
                "PS1 generation witness custody changed",
            ));
        }
        self.require_closed_owner(library, journal)
    }

    fn require_closed_owner(
        &self,
        library: &Library,
        journal: &crate::operation::LifecycleOperation,
    ) -> Result<()> {
        use crate::operation::{LifecycleOperationKind, LifecyclePhase};
        let staging = journal.paths.staging.as_ref().ok_or_else(|| {
            PortcoveError::state("PS1 generation witness has no owned staging root")
        })?;
        crate::path::refuse_symlink_ancestors(library.root())?;
        crate::path::refuse_symlink_ancestors(staging)?;
        let staging_identity = fs::canonicalize(staging)?;
        if self.schema_version != 1
            || self.library_root != fs::canonicalize(library.root())?
            || self.library_id != library.identity()?
            || self.port_id != journal.port_id
            || self.final_path != journal.paths.final_path
            || self.activate != journal.activate
            || self.created_at != journal.created_at
            || self.generated.tree.operation_id() != journal.id
            || self.generated.tree.root() != fs::canonicalize(staging.join("payload"))?
            || self.generated.normalized_disc.root().parent() != Some(staging_identity.as_path())
            || journal.kind != LifecycleOperationKind::Install
            || journal.phase != LifecyclePhase::StagedPreparing
            || journal.install.is_some()
            || journal.preparation.is_some()
            || journal.relocation.is_some()
            || journal.source_import.is_some()
            || journal.paths.quarantine.is_some()
            || !journal.original_paths.is_empty()
            || journal.preparation_process_quiesced != Some(true)
        {
            return Err(PortcoveError::state(
                "PS1 generation witness custody changed",
            ));
        }
        if let Some(binding) = &self.bootstrap {
            binding.require_current(library, &journal.id)?;
        }
        if let Some(binding) = &self.normalized {
            binding.require_current(library, &journal.id)?;
        } else {
            let required: bool = library.connection()?.query_row(
                "SELECT EXISTS(SELECT 1 FROM managed_psx_normalized_inputs WHERE operation_id=?1)
                    OR EXISTS(SELECT 1 FROM managed_psx_pending_generation WHERE operation_id=?1)",
                [&journal.id],
                |row| row.get(0),
            )?;
            if required {
                return Err(PortcoveError::verification(
                    "PS1 normalized generation ancestry is missing",
                ));
            }
        }
        Ok(())
    }

    pub(crate) fn verify(
        &self,
        library: &Library,
        journal: &crate::operation::LifecycleOperation,
        operation: &OperationCoordinator,
    ) -> Result<()> {
        self.verify_fenced(library, journal, operation, || Ok(()), || Ok(()))
    }

    fn verify_fenced(
        &self,
        library: &Library,
        journal: &crate::operation::LifecycleOperation,
        operation: &OperationCoordinator,
        after_inputs: impl FnOnce() -> Result<()> + Send,
        after_outputs: impl FnOnce() -> Result<()>,
    ) -> Result<()> {
        operation.checkpoint()?;
        // Admit the private output path before starting either read. These
        // complete inventories are independent and dispatch no child process;
        // keep both joined under the same cancellation scope and final store
        // fence instead of paying their combined sequential verification cost.
        self.require_owner(library, journal)?;
        let root = journal
            .paths
            .staging
            .as_ref()
            .expect("owner checked staging")
            .join("payload");
        verification::joined_pair(
            || {
                self.verify_inputs(library, journal, operation)?;
                after_inputs()
            },
            || {
                self.generated.tree.verify(&root, operation)?;
                after_outputs()
            },
        )?;
        // The earlier-finishing inventory cannot remain unchecked while the
        // other verifier runs. Fence all three fully hashed inventories again
        // after both settle, before the existing exact durable store fence.
        self.generated
            .toolchain
            .verify_capture_fence(self.generated.toolchain.root(), operation)?;
        self.generated
            .normalized_disc
            .verify_capture_fence(self.generated.normalized_disc.root(), operation)?;
        self.generated.tree.verify_capture_fence(&root, operation)?;
        self.require_owner(library, journal)?;
        operation.checkpoint()
    }

    fn verify_inputs(
        &self,
        library: &Library,
        journal: &crate::operation::LifecycleOperation,
        operation: &OperationCoordinator,
    ) -> Result<()> {
        self.require_owner(library, journal)?;
        if let Some(binding) = &self.normalized {
            binding.verify_inputs(
                &self.generated,
                &self.contract,
                self.bootstrap.as_ref(),
                library,
                journal,
                operation,
            )?;
        }
        self.verify_external_inputs(operation)
    }

    fn verify_external_inputs(&self, operation: &OperationCoordinator) -> Result<()> {
        let preparation = preparation_from_identity(&self.generated.inputs)?;
        let platform = Platform::current()?;
        if !validate_toolchain_with_checkpoint(
            &preparation.toolchain_root,
            platform,
            toolchain_artifact(platform)?,
            || operation.checkpoint(),
        )? {
            return Err(PortcoveError::verification(
                "PS1 generation toolchain identity changed",
            ));
        }
        PreparationConfiguration::from_preparation(&preparation)?;
        crate::adapter::verify_source_storage_identity(&preparation.source, "PS1 source")?;
        if let Some(bios) = &preparation.bios {
            verify_raw_bios(bios, &|| operation.checkpoint())?;
        }
        self.generated
            .toolchain
            .verify(&preparation.toolchain_root, operation)?;
        self.generated
            .normalized_disc
            .verify(self.generated.normalized_disc.root(), operation)?;
        Ok(())
    }

    fn failed_configuration_inventory(
        &self,
        library: &Library,
        closed: &crate::operation::ClosedGenerationPredecessor,
        operation: &OperationCoordinator,
    ) -> Result<stage::GeneratedTree> {
        let journal = closed.journal();
        if journal.last_error.is_none() || self.bootstrap.is_none() || self.normalized.is_none() {
            return Err(PortcoveError::conflict(
                "PS1 failed configuration requires its complete sealed ancestry",
            ));
        }
        self.require_closed_owner(library, journal)?;
        let root = self.generated.tree.root();
        let (_, current) = verification::joined_pair(
            || {
                self.normalized
                    .as_ref()
                    .expect("checked normalized ancestry")
                    .verify_closed_configuration_inputs(
                        &self.generated,
                        &self.contract,
                        self.bootstrap.as_ref(),
                        library,
                        closed,
                        operation,
                    )?;
                self.verify_external_inputs(operation)
            },
            || {
                self.generated
                    .tree
                    .configured_transition(root, operation, true)
            },
        )?;
        self.generated
            .toolchain
            .verify_capture_fence(self.generated.toolchain.root(), operation)?;
        self.generated
            .normalized_disc
            .verify_capture_fence(self.generated.normalized_disc.root(), operation)?;
        current.verify_capture_fence(root, operation)?;
        self.require_closed_owner(library, journal)?;
        operation.checkpoint()?;
        Ok(current)
    }

    pub(crate) fn verify_closed_configuration(
        &self,
        library: &Library,
        closed: &crate::operation::ClosedGenerationPredecessor,
        operation: &OperationCoordinator,
    ) -> Result<()> {
        self.failed_configuration_inventory(library, closed, operation)
            .map(|_| ())
    }

    pub(crate) fn configuration_parent_receipt(&self) -> Result<(String, String)> {
        let sha = self
            .persisted_sha256
            .clone()
            .ok_or_else(|| PortcoveError::state("PS1 configuration generation was not loaded"))?;
        Ok((crate::operation::psx_witness_json(self)?, sha))
    }

    pub(crate) fn require_configuration_pending(&self, json: &str) -> Result<()> {
        let pending: serde_json::Value = serde_json::from_str(json)?;
        let generation = serde_json::to_value(self)?;
        let normalized = generation.get("normalized").ok_or_else(|| {
            PortcoveError::verification("PS1 configuration normalization is missing")
        })?;
        let pending_normalized = pending.get("normalized").ok_or_else(|| {
            PortcoveError::verification("PS1 configuration pending normalization is missing")
        })?;
        if pending.get("generated") != generation.get("generated")
            || pending_normalized.get("binding") != generation.get("bootstrap")
            || pending.get("normalized_sha256") != normalized.get("sha256")
            || pending.get("normalized_json") != normalized.get("json")
            || pending.get("outputs") != normalized.get("outputs")
            || pending.get("attempt_history") != normalized.get("attempt_history")
        {
            return Err(PortcoveError::verification(
                "PS1 configuration pending and sealed predecessors differ",
            ));
        }
        Ok(())
    }

    pub(crate) fn configure_recovered(
        self,
        library: &Library,
        closed: &crate::operation::ClosedGenerationPredecessor,
        preparation: &PsxManagedPreparation,
        operation: &OperationCoordinator,
        receipt: &serde_json::Value,
        confirm_started: impl Fn() -> Result<()>,
    ) -> (Result<ConfiguredInstallWitness>, bool) {
        let mut quiesced = true;
        let result = (|| {
            confirm_started()?;
            let generation_sha256 = self.persisted_sha256.clone().ok_or_else(|| {
                PortcoveError::state("PS1 configuration requires store-loaded generation")
            })?;
            let evidence = configuration_failure_path(closed.journal())?;
            // Exclusive, fixed, permanent hold on every later configure call.
            fs::create_dir(&evidence)?;
            let prior = serde_json::to_vec_pretty(receipt)?;
            if prior.len() > 64 * 1024 {
                return Err(PortcoveError::state(
                    "PS1 configuration failure receipt is oversized",
                ));
            }
            crate::durability::write_bytes_atomically(&evidence.join("prior.json"), &prior, false)?;
            crate::durability::sync_publication(evidence.parent().expect("owned staging parent"))?;
            let outputs = evidence.join("outputs");
            fs::create_dir(&outputs)?;
            let outputs = fs::canonicalize(outputs)?;
            let current = self.failed_configuration_inventory(library, closed, operation)?;
            confirm_started()?;
            let retained = current.preserve_configuration_outputs(&outputs, operation)?;
            let retained_json = serde_json::to_vec(&retained)?;
            if retained_json.len() > 64 * 1024 * 1024 {
                return Err(PortcoveError::state(
                    "PS1 failed configuration inventory is oversized",
                ));
            }
            crate::durability::write_bytes_atomically(
                &evidence.join("outputs.json"),
                &retained_json,
                false,
            )?;
            retained.verify(&outputs, operation)?;
            // No archived result becomes execution authority. The normal
            // primitive hashes inputs again and refuses any existing build.
            confirm_started()?;
            let configured = configure_install_with_recovery(
                self.generated.tree.root(),
                preparation,
                operation,
                &mut quiesced,
                &self.generated,
                true,
            )?;
            Ok(ConfiguredInstallWitness {
                generation: self,
                generation_sha256,
                configured,
                persisted_sha256: None,
            })
        })();
        (result, quiesced)
    }
}

pub(crate) fn configuration_failure_path(
    journal: &crate::operation::LifecycleOperation,
) -> Result<PathBuf> {
    let staging = journal
        .paths
        .staging
        .as_ref()
        .ok_or_else(|| PortcoveError::state("PS1 configuration staging is missing"))?;
    crate::path::refuse_symlink_ancestors(staging)?;
    let evidence = fs::canonicalize(staging)?.join("configuration-failure");
    crate::path::refuse_symlink_ancestors(&evidence)?;
    Ok(evidence)
}

pub(crate) fn require_fresh_configuration_attempt(
    journal: &crate::operation::LifecycleOperation,
) -> Result<()> {
    match fs::symlink_metadata(configuration_failure_path(journal)?) {
        Ok(_) => Err(PortcoveError::conflict(
            "PS1 configuration failure evidence already exists; retain the operation",
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn preparation_identity(preparation: &PsxManagedPreparation) -> Result<Vec<u8>> {
    Ok(serde_json::to_vec(&(
        &preparation.source,
        &preparation.bios,
        &preparation.source_paths,
        &preparation.runtime_source_directory,
        &preparation.toolchain_root,
        &preparation.executable_basename,
    ))?)
}

fn preparation_from_identity(bytes: &[u8]) -> Result<PsxManagedPreparation> {
    let (source, bios, source_paths, runtime_source_directory, toolchain_root, executable_basename) =
        serde_json::from_slice(bytes)?;
    Ok(PsxManagedPreparation {
        source,
        bios,
        source_paths,
        runtime_source_directory,
        toolchain_root,
        executable_basename,
    })
}

struct PreparationConfiguration<'a> {
    primary_source: &'a Path,
    source_paths: &'a [PathBuf],
    runtime_source_directory: Option<&'a Path>,
    executable_basename: &'a str,
}

impl<'a> PreparationConfiguration<'a> {
    fn from_preparation(preparation: &'a PsxManagedPreparation) -> Result<Self> {
        let primary_source = preparation.source_paths.first().ok_or_else(|| {
            PortcoveError::source("managed PS1 preparation has no verified disc source")
                .detail("preparation_field", "source_paths")
        })?;
        let expected = crate::adapter::psx_source_paths(
            &preparation.source.path,
            preparation.source_paths.len(),
        )
        .map_err(|error| error.detail("preparation_field", "source_paths"))?;
        if expected != preparation.source_paths {
            return Err(PortcoveError::source(
                "managed PS1 preparation disc paths do not match the verified source record",
            )
            .detail("preparation_field", "source_paths"));
        }
        crate::archive::validate_relative_path(&preparation.executable_basename, false)
            .map_err(|error| error.detail("preparation_field", "executable_basename"))?;
        if preparation.executable_basename.contains('/') {
            return Err(PortcoveError::verification(
                "managed PS1 executable basename must be a single path component",
            )
            .detail("preparation_field", "executable_basename"));
        }
        let runtime_source_directory = preparation.runtime_source_directory.as_deref();
        if let Some(relative) = runtime_source_directory {
            let text = crate::path::unicode(relative, "managed PS1 runtime source")
                .map_err(|error| error.detail("preparation_field", "runtime_source_directory"))?;
            crate::archive::validate_relative_path(&text.replace('\\', "/"), false)
                .map_err(|error| error.detail("preparation_field", "runtime_source_directory"))?;
            if !preparation.source.path.is_dir() || preparation.source_paths.len() < 2 {
                return Err(PortcoveError::source(
                    "managed PS1 runtime materialization requires a directory with at least two verified discs",
                )
                .detail("preparation_field", "runtime_source_directory"));
            }
        }
        Ok(Self {
            primary_source,
            source_paths: &preparation.source_paths,
            runtime_source_directory,
            executable_basename: &preparation.executable_basename,
        })
    }
}

#[derive(Debug, Clone, Copy)]
struct ToolchainArtifact {
    name: &'static str,
    size: u64,
    sha256: &'static str,
}

#[derive(Debug, Serialize, Deserialize)]
struct ToolchainMarker {
    schema_version: u32,
    version: String,
    platform: Platform,
    asset_name: String,
    sha256: String,
    critical_files: Vec<ToolchainFileIdentity>,
}

#[derive(Debug, Serialize, Deserialize)]
struct ToolchainFileIdentity {
    path: String,
    size: u64,
    sha256: String,
}

#[derive(Debug, Serialize)]
struct ManagedMarker<'a> {
    schema_version: u32,
    adapter: &'a str,
    source_sha256: &'a str,
    source_storage_sha256: &'a str,
    bios_source_sha256: Option<&'a str>,
    toolchain_version: &'a str,
}

// The marker is immutable generation evidence, not mutable runtime state.
#[derive(Deserialize)]
struct GenerationBios {
    schema_version: u32,
    adapter: String,
    bios_source_sha256: Option<String>,
}

pub(crate) fn verify_raw_bios(
    bios: &SourceRecord,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<()> {
    checkpoint()?;
    if bios.sha256 != bios.storage_sha256 || bios.size != bios.storage_size {
        return Err(PortcoveError::unsupported(
            "managed PS1 setup and launch require raw BIOS bytes; register the extracted BIOS file",
        ));
    }
    crate::path::refuse_symlink_ancestors(&bios.path)?;
    if !fs::symlink_metadata(&bios.path)?.is_file() {
        return Err(PortcoveError::source("PS1 BIOS must be a regular raw file"));
    }
    crate::adapter::verify_source_storage_identity(bios, "PS1 BIOS")?;
    checkpoint()
}

pub(crate) fn verified_launch_bios(
    library: &Library,
    port: &crate::PortDefinition,
    install: &crate::InstallRecord,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<Option<SourceRecord>> {
    let Some(profile) = &port.bios_source_profile else {
        return Ok(None);
    };
    checkpoint()?;
    let marker: GenerationBios = serde_json::from_slice(
        &crate::Installer::new(library.clone())?.read_verified_member(
            install,
            ".portcove-managed.json",
            16 * 1024,
        )?,
    )?;
    let bios = library
        .source(profile)?
        .ok_or_else(|| PortcoveError::source("managed PS1 launch requires its registered BIOS"))?;
    if marker.schema_version != 1
        || marker.adapter != "psx-recomp-managed"
        || marker.bios_source_sha256.as_deref() != Some(bios.sha256.as_str())
    {
        return Err(PortcoveError::conflict(
            "PS1 BIOS differs from generation; restore the original BIOS or prepare game data again",
        ));
    }
    verify_raw_bios(&bios, checkpoint)?;
    if serde_json::to_value(library.source(profile)?)? != serde_json::to_value(&bios)? {
        return Err(PortcoveError::conflict(
            "registered PS1 BIOS changed during verification",
        ));
    }
    verify_raw_bios(&bios, &|| Ok(()))?;
    crate::Installer::new(library.clone())?.read_verified_member(
        install,
        ".portcove-managed.json",
        16 * 1024,
    )?;
    Ok(Some(bios))
}

/// Read only the fixed table/string coordinates supported by the selected kits.
/// Ambiguous or unsupported representations fail closed instead of choosing a
/// default cleanup target. Reuse the disc editor's tokenizer and string escapes.
fn bios_config_string(path: &Path, table: &str, field: &str) -> Result<Option<String>> {
    crate::path::refuse_symlink_ancestors(path)?;
    let bytes = crate::path::read_bounded_regular(path, 256 * 1024)?;
    let body = std::str::from_utf8(&bytes)
        .map_err(|_| PortcoveError::install("PS1 BIOS configuration is not UTF-8"))?;
    let (tokens, _) = config_tokens(body)?;
    let mut section = Vec::new();
    let mut seen_table = false;
    let mut found = None;
    let mut cursor = 0;
    while cursor < tokens.len() {
        if tokens[cursor].kind == ConfigTokenKind::Newline {
            cursor += 1;
            continue;
        }
        if tokens[cursor].kind == ConfigTokenKind::Symbol(b'[') {
            let end = tokens[cursor..]
                .iter()
                .position(|token| token.kind == ConfigTokenKind::Newline)
                .map_or(tokens.len(), |offset| cursor + offset);
            let array = tokens
                .get(cursor + 1)
                .is_some_and(|token| token.kind == ConfigTokenKind::Symbol(b'['));
            let delimiters = if array { 2 } else { 1 };
            if end <= cursor + delimiters * 2
                || !tokens[end - delimiters..end]
                    .iter()
                    .all(|token| token.kind == ConfigTokenKind::Symbol(b']'))
            {
                return Err(config_error("invalid BIOS table"));
            }
            section = config_key(body, &tokens[cursor + delimiters..end - delimiters])?;
            if section == [table] {
                if array || seen_table {
                    return Err(config_error("ambiguous BIOS table"));
                }
                seen_table = true;
            } else if section.starts_with(&[table.to_owned(), field.to_owned()]) {
                return Err(config_error("BIOS string coordinate is a table"));
            }
            cursor = end;
            continue;
        }
        let start = cursor;
        while cursor < tokens.len()
            && !matches!(
                tokens[cursor].kind,
                ConfigTokenKind::Symbol(b'=') | ConfigTokenKind::Newline
            )
        {
            cursor += 1;
        }
        if tokens
            .get(cursor)
            .is_none_or(|token| token.kind != ConfigTokenKind::Symbol(b'='))
        {
            return Err(config_error("missing BIOS configuration assignment"));
        }
        let key = config_key(body, &tokens[start..cursor])?;
        cursor += 1;
        let value_start = cursor;
        cursor = bios_config_value_end(&tokens, cursor)?;
        if section.is_empty() && key.first().is_some_and(|name| name == table) {
            return Err(config_error("BIOS coordinates require a fixed table"));
        }
        if section != [table] || key.first().is_none_or(|name| name != field) {
            continue;
        }
        let value = &tokens[value_start..cursor];
        if key.len() != 1
            || found.is_some()
            || value.len() != 1
            || value[0].kind != ConfigTokenKind::String
        {
            return Err(config_error("ambiguous BIOS string coordinate"));
        }
        found = Some(config_key(body, value)?.remove(0));
    }
    Ok(found)
}

fn bios_config_value_end(tokens: &[ConfigToken], start: usize) -> Result<usize> {
    let mut cursor = start;
    let mut nesting = Vec::new();
    while cursor < tokens.len() {
        match tokens[cursor].kind {
            ConfigTokenKind::Newline if nesting.is_empty() => break,
            ConfigTokenKind::Symbol(b'[') => nesting.push(b']'),
            ConfigTokenKind::Symbol(b'{') => nesting.push(b'}'),
            ConfigTokenKind::Symbol(close @ (b']' | b'}')) if nesting.pop() != Some(close) => {
                return Err(config_error("mismatched BIOS value delimiter"));
            }
            _ => {}
        }
        cursor += 1;
    }
    if !nesting.is_empty() || cursor == start {
        return Err(config_error("unfinished BIOS value"));
    }
    Ok(cursor)
}

fn staged_bios_path(root: &Path) -> Result<PathBuf> {
    let profile = bios_config_string(&root.join("game.toml"), "recompiler", "bios_config")?
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "psxrecomp/bios/SCPH1001.toml".into());
    crate::archive::validate_relative_path(&profile, false)?;
    let profile_path = root.join(&profile);
    let bios_root = root.join("psxrecomp/bios");
    if !profile_path.starts_with(&bios_root) {
        return Err(PortcoveError::install(
            "PS1 BIOS profile must be inside the package BIOS directory",
        ));
    }
    let stem = bios_config_string(&profile_path, "recompiler", "out_stem")?
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            profile_path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .map(str::to_owned)
        })
        .ok_or_else(|| PortcoveError::install("PS1 BIOS profile has no output stem"))?;
    crate::archive::validate_relative_path(&stem, false)?;
    if stem.contains('/') {
        return Err(config_error("BIOS output stem must be a single component"));
    }
    let rom = bios_config_string(&profile_path, "program", "rom")?
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| format!("bios/{stem}.BIN"));
    crate::archive::validate_relative_path(&rom, false)?;
    let staged = root.join("psxrecomp").join(rom);
    if !staged.starts_with(&bios_root) || staged == bios_root {
        return Err(PortcoveError::install(
            "staged PS1 BIOS must be inside the package BIOS directory",
        ));
    }
    crate::path::refuse_symlink_ancestors(&staged)?;
    Ok(staged)
}

fn remove_staged_bios(
    staged: &Path,
    bios: &SourceRecord,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<()> {
    verify_raw_bios(bios, checkpoint)?;
    crate::path::refuse_symlink_ancestors(staged)?;
    let metadata = fs::symlink_metadata(staged)?;
    if !metadata.is_file() || fs::canonicalize(staged)? == fs::canonicalize(&bios.path)? {
        return Err(PortcoveError::verification(
            "staged PS1 BIOS aliases its original or is not a regular copy",
        ));
    }
    let (digest, size) = hash_file(staged)?;
    if digest != bios.storage_sha256 || size != bios.storage_size {
        return Err(PortcoveError::verification(
            "staged PS1 BIOS differs from the verified generation input",
        ));
    }
    checkpoint()?;
    verify_raw_bios(bios, &|| Ok(()))?;
    crate::path::refuse_symlink_ancestors(staged)?;
    let (current_digest, current_size) = hash_file(staged)?;
    if current_digest != digest
        || current_size != size
        || fs::canonicalize(staged)? == fs::canonicalize(&bios.path)?
    {
        return Err(PortcoveError::verification(
            "staged PS1 BIOS changed before cleanup",
        ));
    }
    fs::remove_file(staged)?;
    Ok(())
}

struct DirectoryGuard(PathBuf);

impl Drop for DirectoryGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub(crate) async fn ensure_toolchain<F>(
    library: &Library,
    platform: Platform,
    parent: &OperationCoordinator,
    emit: &mut F,
) -> Result<PathBuf>
where
    F: FnMut(OperationEvent),
{
    let operation = parent.child("psx_toolchain", None);
    emit(operation.started());
    let result = ensure_toolchain_inner(library, platform, &operation, emit).await;
    emit(operation.finished(if result.is_ok() {
        OperationResult::Succeeded
    } else {
        OperationResult::Failed
    }));
    result
}

async fn ensure_toolchain_inner<F>(
    library: &Library,
    platform: Platform,
    operation: &OperationCoordinator,
    emit: &mut F,
) -> Result<PathBuf>
where
    F: FnMut(OperationEvent),
{
    let artifact = toolchain_artifact(platform)?;
    let destination = library
        .toolchains_dir()
        .join("cmake-clang-v1")
        .join(TOOLCHAIN_VERSION);
    if validate_toolchain(&destination, platform, artifact)? {
        return Ok(destination);
    }

    let operation_root = library
        .staging_dir()
        .join(format!("psx-toolchain-{}", Uuid::new_v4()));
    let guard = DirectoryGuard(operation_root.clone());
    let unpacked = operation_root.join("unpacked");
    fs::create_dir_all(&unpacked)?;
    let archive_path = operation_root.join(artifact.name);
    let url = format!(
        "https://github.com/TechnicallyComputers/retcomm-toolchains/releases/download/v{TOOLCHAIN_VERSION}/{}",
        artifact.name
    );
    let client = reqwest::Client::builder()
        .user_agent(concat!("Portcove/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| PortcoveError::network(error.to_string()))?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| PortcoveError::network(error.to_string()))?
        .error_for_status()
        .map_err(|error| PortcoveError::network(error.to_string()))?;
    validate_download_progress(0, artifact.size)?;
    let mut stream = response.bytes_stream();
    let mut file = tokio::fs::File::create(&archive_path).await?;
    let mut completed = 0_u64;
    let mut reported = 0_u64;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| PortcoveError::network(error.to_string()))?;
        file.write_all(&chunk).await?;
        completed += chunk.len() as u64;
        validate_download_progress(completed, artifact.size)?;
        if completed == artifact.size || completed.saturating_sub(reported) >= 1024 * 1024 {
            emit(operation.progress("psx-toolchain-download", completed, Some(artifact.size)));
            reported = completed;
        }
    }
    if completed != reported {
        emit(operation.progress("psx-toolchain-download", completed, Some(artifact.size)));
    }
    file.flush().await?;
    drop(file);
    validate_download_size(completed, artifact.size)?;
    let (actual_sha256, actual_size) = hash_file(&archive_path)?;
    if actual_size != artifact.size || !actual_sha256.eq_ignore_ascii_case(artifact.sha256) {
        return Err(PortcoveError::verification(
            "PS1 toolchain failed its pinned artifact verification",
        )
        .detail("expected_sha256", artifact.sha256)
        .detail("actual_sha256", actual_sha256)
        .detail("expected_size", artifact.size.to_string())
        .detail("actual_size", actual_size.to_string()));
    }

    extract_archive(&archive_path, &unpacked, artifact.name, artifact.size)?;
    let pack_root = locate_pack_root(&unpacked)?;
    let critical_files = toolchain_file_identities(&pack_root, platform)?;
    let marker = ToolchainMarker {
        schema_version: 2,
        version: TOOLCHAIN_VERSION.into(),
        platform,
        asset_name: artifact.name.into(),
        sha256: artifact.sha256.into(),
        critical_files,
    };
    fs::write(
        pack_root.join(".portcove-toolchain.json"),
        serde_json::to_vec_pretty(&marker)?,
    )?;
    fs::create_dir_all(destination.parent().expect("toolchain has a parent"))?;
    if destination.exists() {
        fs::remove_dir_all(&destination)?;
    }
    crate::durability::rename_noreplace(&pack_root, &destination)?;
    if !validate_toolchain(&destination, platform, artifact)? {
        return Err(PortcoveError::verification(
            "installed PS1 toolchain did not pass its post-install checks",
        ));
    }
    drop(guard);
    Ok(destination)
}

pub(crate) fn prepare_install(
    root: &Path,
    preparation: &PsxManagedPreparation,
    operation: &OperationCoordinator,
) -> (Result<()>, bool) {
    let mut quiesced = true;
    let result = prepare_install_inner(root, preparation, operation, &mut quiesced);
    (result, quiesced)
}

pub(crate) fn generate_install_stage(
    root: &Path,
    preparation: &PsxManagedPreparation,
    operation: &OperationCoordinator,
) -> (Result<GeneratedInstall>, bool) {
    let mut quiesced = true;
    let result = generate_install(root, preparation, operation, &mut quiesced);
    (result, quiesced)
}

fn prepare_install_inner(
    root: &Path,
    preparation: &PsxManagedPreparation,
    operation: &OperationCoordinator,
    quiesced: &mut bool,
) -> Result<()> {
    let generated = generate_install(root, preparation, operation, quiesced)?;
    finish_generated_install(root, preparation, operation, quiesced, generated)
}

fn generate_install(
    root: &Path,
    preparation: &PsxManagedPreparation,
    operation: &OperationCoordinator,
    quiesced: &mut bool,
) -> Result<GeneratedInstall> {
    #[cfg(feature = "qualification-fixtures")]
    let mut trace = qualification_trace::Trace::new(operation.operation_id(), "generation_entry");
    #[cfg(feature = "qualification-fixtures")]
    trace.phase("source_identity");
    operation.checkpoint()?;
    crate::adapter::verify_source_storage_identity(&preparation.source, "PS1 source")?;
    #[cfg(feature = "qualification-fixtures")]
    trace.phase("bios_identity");
    if let Some(bios) = &preparation.bios {
        verify_raw_bios(bios, &|| operation.checkpoint())?;
    }
    #[cfg(feature = "qualification-fixtures")]
    trace.phase("preparation_contracts");
    let configuration = PreparationConfiguration::from_preparation(preparation)?;
    let cli = root.join("psxrecomp").join("psxrecomp_cli.py");
    let config = root.join("game.toml");
    if !cli.is_file() || !config.is_file() {
        return Err(PortcoveError::install(
            "PS1 setup package is missing its fixed psxrecomp CLI contract",
        ));
    }
    let inputs = preparation_identity(preparation)?;
    let staged_bios = if let Some(bios) = &preparation.bios {
        let staged = staged_bios_path(root)?;
        if crate::path::resolve_existing_ancestor(&staged)? == fs::canonicalize(&bios.path)? {
            return Err(PortcoveError::verification(
                "staged PS1 BIOS aliases its original",
            ));
        }
        Some(staged)
    } else {
        None
    };
    #[cfg(feature = "qualification-fixtures")]
    trace.phase("python_selection");
    let python = toolchain_python(&preparation.toolchain_root)?;
    #[cfg(feature = "qualification-fixtures")]
    trace.phase("toolchain_inventory");
    let toolchain = stage::GeneratedTree::capture(&preparation.toolchain_root, operation, true)?;
    #[cfg(feature = "qualification-fixtures")]
    trace.complete();
    #[cfg(feature = "qualification-fixtures")]
    drop(trace);
    operation.checkpoint()?;
    let temporary = retained_source_workspace(root)?;
    let cue = materialize_managed_disc(
        configuration.primary_source,
        &temporary,
        None,
        operation,
        quiesced,
    )?;
    let normalized_disc = stage::GeneratedTree::capture(&temporary, operation, *quiesced)?;
    operation.checkpoint()?;
    crate::adapter::verify_source_storage_identity(&preparation.source, "PS1 source")?;
    let generate_arguments = generation_arguments(
        &config,
        root,
        &cue,
        preparation.bios.as_ref().map(|bios| bios.path.as_path()),
    )?;
    run_cli(
        &python,
        &cli,
        root,
        &preparation.toolchain_root,
        generate_arguments.clone(),
        operation,
        quiesced,
    )?;
    if let Some(bios) = &preparation.bios {
        verify_raw_bios(bios, &|| operation.checkpoint())?;
    }
    rewrite_game_discs(&config, configuration.source_paths)?;
    crate::adapter::verify_source_storage_identity(&preparation.source, "PS1 source")?;
    toolchain.verify(&preparation.toolchain_root, operation)?;
    normalized_disc.verify(&temporary, operation)?;
    Ok(GeneratedInstall {
        tree: stage::GeneratedTree::capture_normalized_generation(root, operation, *quiesced)?,
        toolchain,
        normalized_disc,
        inputs,
        generation_arguments: generate_arguments,
        staged_bios,
    })
}

fn finish_generated_install(
    root: &Path,
    preparation: &PsxManagedPreparation,
    operation: &OperationCoordinator,
    quiesced: &mut bool,
    generated: GeneratedInstall,
) -> Result<()> {
    if generated.inputs != preparation_identity(preparation)? {
        return Err(PortcoveError::verification(
            "PS1 preparation inputs changed before continuation",
        ));
    }
    generated.tree.verify(root, operation)?;
    generated
        .normalized_disc
        .verify(generated.normalized_disc.root(), operation)?;
    generated
        .toolchain
        .verify(&preparation.toolchain_root, operation)?;
    crate::adapter::verify_source_storage_identity(&preparation.source, "PS1 source")?;
    if let Some(bios) = &preparation.bios {
        verify_raw_bios(bios, &|| operation.checkpoint())?;
    }
    let configuration = PreparationConfiguration::from_preparation(preparation)?;
    let config = root.join("game.toml");
    let cli = root.join("psxrecomp").join("psxrecomp_cli.py");
    let python = toolchain_python(&preparation.toolchain_root)?;
    let staged_bios = generated.staged_bios;
    let build_dir = root.join("build-portcove");
    run_cli(
        &python,
        &cli,
        root,
        &preparation.toolchain_root,
        rebuild_arguments(&config, root, &build_dir, configuration.executable_basename)?,
        operation,
        quiesced,
    )?;
    prepare_built_runtime(root, preparation, operation, quiesced, staged_bios, None)?;
    Ok(())
}

fn prepare_built_runtime(
    root: &Path,
    preparation: &PsxManagedPreparation,
    operation: &OperationCoordinator,
    quiesced: &mut bool,
    staged_bios: Option<PathBuf>,
    sealed_inputs: Option<&stage::GeneratedTree>,
) -> Result<Vec<(PathBuf, PathBuf)>> {
    let retain_inputs = sealed_inputs.is_some();
    if retain_inputs && preparation.runtime_source_directory.is_some() {
        return Err(PortcoveError::unsupported(
            "bounded multi-disc runtime extraction requires a separate supervised stage",
        ));
    }
    let configuration = PreparationConfiguration::from_preparation(preparation)?;
    let config = root.join("game.toml");
    let build_dir = root.join("build-portcove");
    let executable = platform_executable(&build_dir, configuration.executable_basename);
    if !executable.is_file() {
        return Err(PortcoveError::install(format!(
            "PS1 build completed without {}",
            executable.display()
        )));
    }
    let runtime_sources = if let Some(relative) = configuration.runtime_source_directory {
        operation.checkpoint()?;
        *quiesced = false;
        materialize_runtime_raw_set(
            &build_dir,
            relative,
            &preparation.source,
            configuration.source_paths,
        )?
    } else {
        configuration.source_paths.to_vec()
    };
    let runtime_config = build_dir.join("game.toml");
    prepare_runtime_config(&config, &runtime_config, &runtime_sources)?;
    crate::adapter::verify_source_storage_identity(&preparation.source, "PS1 source")?;
    let mut removed = Vec::new();
    let retained_root = root
        .parent()
        .ok_or_else(|| PortcoveError::state("PS1 payload owner missing"))?
        .join("finalization-inputs");
    if retain_inputs {
        crate::path::refuse_symlink_ancestors(&retained_root)?;
        fs::create_dir(&retained_root)?;
    }
    let prepared_disc = root.join("disc");
    if prepared_disc.is_dir() {
        if let Some(sealed) = sealed_inputs {
            sealed.archive_input(Path::new("disc"), &retained_root.join("disc"), operation)?;
            removed.push((PathBuf::from("disc"), PathBuf::from("disc")));
        } else {
            fs::remove_dir_all(prepared_disc)?;
        }
    }
    if let (Some(staged), Some(bios)) = (&staged_bios, &preparation.bios) {
        if let Some(sealed) = sealed_inputs {
            verify_raw_bios(bios, &|| operation.checkpoint())?;
            if fs::canonicalize(staged)? == fs::canonicalize(&bios.path)? {
                return Err(PortcoveError::verification(
                    "PS1 staged BIOS aliases its original",
                ));
            }
            let before =
                crate::external_runtime::hash_stable_file(staged, bios.storage_size, &|| {
                    operation.checkpoint()
                })?;
            if before.sha256 != bios.storage_sha256 || before.size() != bios.storage_size {
                return Err(PortcoveError::verification(
                    "PS1 staged BIOS changed before retention",
                ));
            }
            let relative = staged
                .strip_prefix(root)
                .map_err(|_| PortcoveError::verification("PS1 staged BIOS escaped payload"))?
                .to_path_buf();
            let destination = retained_root.join("staged-bios.bin");
            sealed.archive_input(&relative, &destination, operation)?;
            let after = crate::external_runtime::hash_stable_file(
                &destination,
                bios.storage_size,
                &|| operation.checkpoint(),
            )?;
            if !before.same_content_object(&after) {
                return Err(PortcoveError::verification(
                    "PS1 retained BIOS object changed",
                ));
            }
            verify_raw_bios(bios, &|| operation.checkpoint())?;
            removed.push((relative, PathBuf::from("staged-bios.bin")));
        } else {
            remove_staged_bios(staged, bios, &|| operation.checkpoint())?;
        }
    }
    fs::write(
        root.join(".portcove-managed.json"),
        serde_json::to_vec_pretty(&ManagedMarker {
            schema_version: 1,
            adapter: "psx-recomp-managed",
            source_sha256: &preparation.source.sha256,
            source_storage_sha256: &preparation.source.storage_sha256,
            bios_source_sha256: preparation.bios.as_ref().map(|bios| bios.sha256.as_str()),
            toolchain_version: TOOLCHAIN_VERSION,
        })?,
    )?;
    Ok(removed)
}

pub(crate) fn rewrite_game_discs(config: &Path, sources: &[PathBuf]) -> Result<()> {
    let body = fs::read_to_string(config)?;
    fs::write(config, rewritten_game_discs(&body, sources)?)?;
    Ok(())
}

fn rewritten_game_discs(body: &str, sources: &[PathBuf]) -> Result<String> {
    if sources.is_empty() {
        return Err(config_error("no verified disc sources"));
    }
    let (tokens, comments) = config_tokens(&body)?;
    let (header_end, field) = config_disc_field(&body, &tokens)?;
    let newline = if body.contains("\r\n") { "\r\n" } else { "\n" };
    let sources = sources
        .iter()
        .map(|source| {
            // JSON and TOML 1.0 basic strings share these escapes, except that
            // TOML also requires DEL to be escaped.
            Ok(
                serde_json::to_string(&crate::path::unicode(source, "PS1 source")?)?
                    .replace('\u{7f}', "\\u007F"),
            )
        })
        .collect::<Result<Vec<_>>>()?;
    let key = if sources.len() == 1 { "disc" } else { "discs" };
    let retained_comments = field
        .as_ref()
        .map(|(_, value)| {
            comments
                .iter()
                .filter(|comment| value.start <= comment.start && comment.end <= value.end)
                .map(|comment| &body[comment.clone()])
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let mut value = if sources.len() == 1 {
        sources[0].clone()
    } else {
        format!("[{newline}")
    };
    if sources.len() > 1 {
        for source in &sources {
            value.push_str(&format!("    {source},{newline}"));
        }
        for comment in &retained_comments {
            value.push_str(&format!("    {comment}{newline}"));
        }
        value.push(']');
    } else if !retained_comments.is_empty() {
        value.push_str(newline);
        value.push_str(&retained_comments.join(newline));
        // Keep the original trailing comment separate from comments that were
        // inside the replaced array; leave the original EOF/newline untouched.
        let suffix = &body[field.as_ref().expect("comments have a field").1.end..];
        if suffix.trim_start_matches([' ', '\t']).starts_with('#') {
            value.push_str(newline);
        }
    }

    // Only the key/value spans change. UTF-8, unrelated text, line endings and
    // the final newline are retained; comments within old values remain in order.
    // This is an editor for the fixed game/disc contract, not a TOML validator.
    let mut output = body.to_owned();
    if let Some((old_key, old_value)) = field {
        output.replace_range(old_value, &value);
        if config_key(&body, tokens_for_range(&tokens, &old_key))? != [key] {
            let replacement = match body.as_bytes()[old_key.start] {
                b'\'' => format!("'{key}'"),
                b'"' => format!("\"{key}\""),
                _ => key.to_string(),
            };
            output.replace_range(old_key, &replacement);
        }
    } else {
        let separator = if body[..header_end].ends_with('\n') {
            ""
        } else {
            newline
        };
        let ending = if header_end < body.len() || body.ends_with('\n') {
            newline
        } else {
            ""
        };
        output.insert_str(header_end, &format!("{separator}{key} = {value}{ending}"));
    }
    Ok(output)
}

#[derive(Clone, Copy, PartialEq)]
enum ConfigTokenKind {
    Text,
    String,
    Symbol(u8),
    Newline,
}

struct ConfigToken {
    kind: ConfigTokenKind,
    span: std::ops::Range<usize>,
}

fn config_error(reason: &str) -> PortcoveError {
    PortcoveError::install(format!("cannot rewrite PS1 disc configuration: {reason}"))
}

fn config_escape(body: &str, start: usize) -> Result<(usize, char)> {
    let bytes = body.as_bytes();
    let escaped = *bytes
        .get(start + 1)
        .ok_or_else(|| config_error("unfinished escape"))?;
    let simple = match escaped {
        b'b' => Some('\u{8}'),
        b't' => Some('\t'),
        b'n' => Some('\n'),
        b'f' => Some('\u{c}'),
        b'r' => Some('\r'),
        b'"' => Some('"'),
        b'\\' => Some('\\'),
        _ => None,
    };
    if let Some(character) = simple {
        return Ok((start + 2, character));
    }
    let digits = match escaped {
        b'u' => 4,
        b'U' => 8,
        _ => return Err(config_error("invalid TOML 1.0 escape")),
    };
    let end = start + 2 + digits;
    let hexadecimal = body
        .get(start + 2..end)
        .ok_or_else(|| config_error("unfinished Unicode escape"))?;
    if !hexadecimal.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(config_error("invalid Unicode escape"));
    }
    let character = u32::from_str_radix(hexadecimal, 16)
        .ok()
        .and_then(char::from_u32)
        .ok_or_else(|| config_error("invalid Unicode scalar"))?;
    Ok((end, character))
}

fn config_string_end(body: &str, start: usize) -> Result<usize> {
    let bytes = body.as_bytes();
    let quote = bytes[start];
    let multiline = bytes
        .get(start..start + 3)
        .is_some_and(|run| run == [quote; 3]);
    let mut cursor = start + if multiline { 3 } else { 1 };
    while cursor < bytes.len() {
        let byte = bytes[cursor];
        if byte == quote {
            let count = bytes[cursor..]
                .iter()
                .take_while(|byte| **byte == quote)
                .count();
            if !multiline {
                return Ok(cursor + 1);
            }
            if count >= 3 {
                if count > 5 {
                    return Err(config_error("invalid multiline string delimiter"));
                }
                return Ok(cursor + count);
            }
            cursor += count;
        } else if byte == b'\\' && quote == b'"' {
            let mut next = cursor + 1;
            while multiline
                && bytes
                    .get(next)
                    .is_some_and(|byte| matches!(byte, b' ' | b'\t'))
            {
                next += 1;
            }
            if multiline
                && bytes
                    .get(next)
                    .is_some_and(|byte| matches!(byte, b'\r' | b'\n'))
            {
                while bytes
                    .get(next)
                    .is_some_and(|byte| matches!(byte, b' ' | b'\t' | b'\r' | b'\n'))
                {
                    if bytes[next] == b'\r' && bytes.get(next + 1) != Some(&b'\n') {
                        return Err(config_error("invalid newline"));
                    }
                    next += 1;
                }
                cursor = next;
            } else {
                cursor = config_escape(body, cursor)?.0;
            }
        } else if byte == b'\n' || byte == b'\r' {
            if !multiline || (byte == b'\r' && bytes.get(cursor + 1) != Some(&b'\n')) {
                return Err(config_error("invalid string newline"));
            }
            cursor += if byte == b'\r' { 2 } else { 1 };
        } else {
            if matches!(byte, 0..=8 | 11..=31 | 127) {
                return Err(config_error("invalid string control character"));
            }
            cursor += 1;
        }
    }
    Err(config_error("unterminated string"))
}

type ConfigSpans = (Vec<ConfigToken>, Vec<std::ops::Range<usize>>);

fn config_tokens(body: &str) -> Result<ConfigSpans> {
    let bytes = body.as_bytes();
    let mut tokens = Vec::new();
    let mut comments = Vec::new();
    let mut cursor = 0;
    while cursor < bytes.len() {
        let start = cursor;
        let kind = match bytes[cursor] {
            b' ' | b'\t' => {
                cursor += 1;
                continue;
            }
            b'\r' | b'\n' => {
                if bytes[cursor] == b'\r' {
                    if bytes.get(cursor + 1) != Some(&b'\n') {
                        return Err(config_error("invalid newline"));
                    }
                    cursor += 1;
                }
                cursor += 1;
                ConfigTokenKind::Newline
            }
            b'#' => {
                while cursor < bytes.len() && !matches!(bytes[cursor], b'\r' | b'\n') {
                    if matches!(bytes[cursor], 0..=8 | 11..=31 | 127) {
                        return Err(config_error("invalid comment control character"));
                    }
                    cursor += 1;
                }
                comments.push(start..cursor);
                continue;
            }
            b'\'' | b'"' => {
                cursor = config_string_end(body, cursor)?;
                ConfigTokenKind::String
            }
            symbol @ (b'[' | b']' | b'{' | b'}' | b'=' | b'.' | b',') => {
                cursor += 1;
                ConfigTokenKind::Symbol(symbol)
            }
            _ => {
                while cursor < bytes.len()
                    && !matches!(
                        bytes[cursor],
                        b' ' | b'\t'
                            | b'\r'
                            | b'\n'
                            | b'#'
                            | b'\''
                            | b'"'
                            | b'['
                            | b']'
                            | b'{'
                            | b'}'
                            | b'='
                            | b'.'
                            | b','
                    )
                {
                    if bytes[cursor].is_ascii_control() {
                        return Err(config_error("invalid control character"));
                    }
                    cursor += 1;
                }
                ConfigTokenKind::Text
            }
        };
        tokens.push(ConfigToken {
            kind,
            span: start..cursor,
        });
    }
    Ok((tokens, comments))
}

fn tokens_for_range<'a>(
    tokens: &'a [ConfigToken],
    span: &std::ops::Range<usize>,
) -> &'a [ConfigToken] {
    let start = tokens.partition_point(|token| token.span.start < span.start);
    let end = tokens.partition_point(|token| token.span.end <= span.end);
    &tokens[start..end]
}

fn config_key(body: &str, tokens: &[ConfigToken]) -> Result<Vec<String>> {
    let mut parts = Vec::new();
    for (index, token) in tokens.iter().enumerate() {
        if index % 2 == 1 {
            if token.kind != ConfigTokenKind::Symbol(b'.') {
                return Err(config_error("invalid dotted key"));
            }
            continue;
        }
        let text = &body[token.span.clone()];
        let part = match token.kind {
            ConfigTokenKind::Text
                if text
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')) =>
            {
                text.to_string()
            }
            ConfigTokenKind::String if !text.starts_with("\"\"\"") && !text.starts_with("'''") => {
                let mut part = String::new();
                let mut cursor = token.span.start + 1;
                while cursor < token.span.end - 1 {
                    if body.as_bytes()[cursor] == b'\\' && text.starts_with('"') {
                        let (next, character) = config_escape(body, cursor)?;
                        part.push(character);
                        cursor = next;
                    } else {
                        let character = body[cursor..].chars().next().expect("character in string");
                        part.push(character);
                        cursor += character.len_utf8();
                    }
                }
                part
            }
            _ => return Err(config_error("invalid key")),
        };
        parts.push(part);
    }
    if tokens.is_empty() || tokens.len().is_multiple_of(2) {
        return Err(config_error("unfinished key"));
    }
    Ok(parts)
}

type ConfigDiscField = (
    usize,
    Option<(std::ops::Range<usize>, std::ops::Range<usize>)>,
);

fn config_disc_field(body: &str, tokens: &[ConfigToken]) -> Result<ConfigDiscField> {
    let mut cursor = 0;
    let mut in_game = false;
    let mut header_end = None;
    let mut field = None;
    while cursor < tokens.len() {
        if tokens[cursor].kind == ConfigTokenKind::Newline {
            cursor += 1;
            continue;
        }
        let start = cursor;
        if tokens[cursor].kind == ConfigTokenKind::Symbol(b'[') {
            let end = tokens[cursor..]
                .iter()
                .position(|token| token.kind == ConfigTokenKind::Newline)
                .map_or(tokens.len(), |offset| cursor + offset);
            let array = tokens
                .get(cursor + 1)
                .is_some_and(|token| token.kind == ConfigTokenKind::Symbol(b'['));
            let delimiters = if array { 2 } else { 1 };
            if end <= cursor + delimiters * 2
                || !tokens[end - delimiters..end]
                    .iter()
                    .all(|token| token.kind == ConfigTokenKind::Symbol(b']'))
            {
                return Err(config_error("invalid table header"));
            }
            let key = config_key(body, &tokens[cursor + delimiters..end - delimiters])?;
            in_game = key == ["game"];
            if key.first().is_some_and(|key| key == "game")
                && key
                    .get(1)
                    .is_some_and(|key| matches!(key.as_str(), "disc" | "discs"))
            {
                return Err(config_error("disc field is a table"));
            }
            if in_game {
                if array || header_end.is_some() {
                    return Err(config_error("ambiguous game table"));
                }
                header_end = Some(tokens.get(end).map_or(body.len(), |token| token.span.end));
            }
            cursor = end;
            continue;
        }
        while cursor < tokens.len()
            && !matches!(
                tokens[cursor].kind,
                ConfigTokenKind::Symbol(b'=') | ConfigTokenKind::Newline
            )
        {
            cursor += 1;
        }
        if tokens
            .get(cursor)
            .is_none_or(|token| token.kind != ConfigTokenKind::Symbol(b'='))
        {
            return Err(config_error("missing assignment"));
        }
        let equals = cursor;
        let key = config_key(body, &tokens[start..equals])?;
        cursor += 1;
        let value_start = cursor;
        let mut nesting = Vec::new();
        while cursor < tokens.len() {
            match tokens[cursor].kind {
                ConfigTokenKind::Newline if nesting.is_empty() => break,
                ConfigTokenKind::Symbol(b'[') => nesting.push(b']'),
                ConfigTokenKind::Symbol(b'{') => nesting.push(b'}'),
                ConfigTokenKind::Symbol(close @ (b']' | b'}')) if nesting.pop() != Some(close) => {
                    return Err(config_error("mismatched value delimiter"));
                }
                _ => {}
            }
            cursor += 1;
        }
        if !nesting.is_empty() || cursor == value_start {
            return Err(config_error("unfinished value"));
        }
        if in_game
            && key
                .first()
                .is_some_and(|key| matches!(key.as_str(), "disc" | "discs"))
        {
            if key.len() != 1 || field.is_some() {
                return Err(config_error("ambiguous disc field"));
            }
            validate_disc_tokens(&tokens[value_start..cursor], key[0] == "discs")?;
            field = Some((
                tokens[start].span.start..tokens[equals - 1].span.end,
                tokens[value_start].span.start..tokens[cursor - 1].span.end,
            ));
        }
    }
    Ok((
        header_end.ok_or_else(|| config_error("missing game table"))?,
        field,
    ))
}

fn validate_disc_tokens(tokens: &[ConfigToken], plural: bool) -> Result<()> {
    if !plural {
        return if tokens.len() == 1 && tokens[0].kind == ConfigTokenKind::String {
            Ok(())
        } else {
            Err(config_error("disc must be a string"))
        };
    }
    if tokens
        .first()
        .is_none_or(|token| token.kind != ConfigTokenKind::Symbol(b'['))
        || tokens
            .last()
            .is_none_or(|token| token.kind != ConfigTokenKind::Symbol(b']'))
    {
        return Err(config_error("discs must be a string array"));
    }
    let mut expect_string = true;
    for token in &tokens[1..tokens.len() - 1] {
        match token.kind {
            ConfigTokenKind::Newline => {}
            ConfigTokenKind::String if expect_string => expect_string = false,
            ConfigTokenKind::Symbol(b',') if !expect_string => expect_string = true,
            _ => return Err(config_error("invalid disc array member")),
        }
    }
    Ok(())
}

fn prepare_runtime_config(project: &Path, runtime: &Path, sources: &[PathBuf]) -> Result<()> {
    if !runtime.is_file() {
        fs::copy(project, runtime)?;
    }
    rewrite_game_discs(runtime, sources)
}

fn materialize_runtime_raw_set(
    build_dir: &Path,
    relative: &Path,
    source: &SourceRecord,
    source_paths: &[PathBuf],
) -> Result<Vec<PathBuf>> {
    let relative_text = crate::path::unicode(relative, "managed PS1 runtime source")?;
    let normalized_relative = relative_text.replace('\\', "/");
    crate::archive::validate_relative_path(&normalized_relative, false)?;
    let destination = build_dir.join(relative);
    crate::adapter::materialize_psx_cue_set(&source.path, &destination)?;

    let mut runtime_sources = Vec::with_capacity(source_paths.len());
    let mut hashes = Vec::with_capacity(source_paths.len());
    let mut total_size = 0_u64;
    for index in 0..source_paths.len() {
        let bin_filename = format!("disc-{:02}.bin", index + 1);
        let materialized = destination.join(&bin_filename);
        if !materialized.is_file() {
            return Err(PortcoveError::verification(format!(
                "managed PS1 runtime source is missing {bin_filename}"
            )));
        }
        let (sha256, size) = hash_file(&materialized)?;
        hashes.push(sha256);
        total_size = total_size.saturating_add(size);
        let cue_filename = format!("disc-{:02}.cue", index + 1);
        if !destination.join(&cue_filename).is_file() {
            return Err(PortcoveError::verification(format!(
                "managed PS1 runtime source is missing {cue_filename}"
            )));
        }
        runtime_sources.push(PathBuf::from(format!(
            "{normalized_relative}/{cue_filename}"
        )));
    }
    let aggregate = crate::adapter::aggregate_sha256(&hashes);
    if aggregate != source.sha256 || total_size != source.size {
        return Err(PortcoveError::verification(
            "managed PS1 runtime source does not match the verified disc set",
        )
        .detail("expected_sha256", &source.sha256)
        .detail("actual_sha256", aggregate)
        .detail("expected_size", source.size.to_string())
        .detail("actual_size", total_size.to_string()));
    }
    Ok(runtime_sources)
}

fn retained_source_workspace(root: &Path) -> Result<PathBuf> {
    // Disarm automatic removal before any possible native owner, including
    // unwind. The Install journal owns this directory beneath staging.
    Ok(tempfile::Builder::new()
        .prefix("psx-source-")
        .tempdir_in(root.parent().unwrap_or(root))?
        .keep())
}

fn materialize_managed_disc(
    source: &Path,
    destination: &Path,
    pinned_tool: Option<&Path>,
    operation: &OperationCoordinator,
    quiesced: &mut bool,
) -> Result<PathBuf> {
    operation.checkpoint()?;
    let previous_quiescence = *quiesced;
    *quiesced = false;
    let mut command_quiesced = false;
    let result = crate::adapter::materialize_psx_chd_with_tool(
        source,
        destination,
        pinned_tool,
        &|| operation.checkpoint(),
        crate::tool_process::ToolProcessObserver {
            diagnostics: None,
            quiesced: Some(&mut || {
                command_quiesced = true;
                Ok(())
            }),
        },
    );
    // A later successful command cannot erase an earlier uncertain owner.
    *quiesced = previous_quiescence && command_quiesced;
    result
}

fn builder_supervision_error(error: PortcoveError) -> PortcoveError {
    if error.code == crate::ErrorCode::Launch {
        let mut mapped = PortcoveError::install(format!("could not run PS1 builder: {error}"));
        mapped
            .details
            .extend(crate::tool_process::copy_proof_details(&error));
        mapped
    } else {
        error
    }
}

fn generation_arguments(
    config: &Path,
    root: &Path,
    disc: &Path,
    bios: Option<&Path>,
) -> Result<Vec<String>> {
    let mut arguments = vec![
        "generate".into(),
        "--config".into(),
        crate::adapter::psx_launch_path(config)?,
        "--project-root".into(),
        crate::adapter::psx_launch_path(root)?,
        "--disc".into(),
        crate::adapter::psx_launch_path(disc)?,
        "--json-progress".into(),
        "--no-toolchain-download".into(),
    ];
    if let Some(bios) = bios {
        arguments.extend(["--bios".into(), crate::adapter::psx_launch_path(bios)?]);
    }
    Ok(arguments)
}

fn rebuild_arguments(
    config: &Path,
    root: &Path,
    build_dir: &Path,
    executable_basename: &str,
) -> Result<Vec<String>> {
    Ok(vec![
        "rebuild".into(),
        "--config".into(),
        crate::path::unicode(config, "managed build config")?,
        "--project-root".into(),
        crate::path::unicode(root, "managed build root")?,
        "--build-dir".into(),
        crate::path::unicode(build_dir, "managed build directory")?,
        "--target".into(),
        "psx-runtime".into(),
        "--exe-basename".into(),
        executable_basename.into(),
        "--no-pgo".into(),
        "--no-toolchain-download".into(),
        "--prune-after".into(),
        "build-intermediates".into(),
        "--json-progress".into(),
        // Keep each -D value joined to its option for argparse. Explicit empty
        // launchers prevent the SDK's optional ccache discovery; supervision's
        // retained lifetime membership limit still applies to direct compilers.
        "--cmake-extra=-DCMAKE_C_COMPILER_LAUNCHER:STRING=".into(),
        "--cmake-extra=-DCMAKE_CXX_COMPILER_LAUNCHER:STRING=".into(),
    ])
}

fn run_cli(
    python: &Path,
    cli: &Path,
    project_root: &Path,
    toolchain_root: &Path,
    arguments: impl IntoIterator<Item = String>,
    operation: &OperationCoordinator,
    quiesced: &mut bool,
) -> Result<()> {
    // The packaged C++ emitter also consumes these Python working coordinates.
    // Reuse the identity-checked spelling already required by its runtime.
    let project_root = PathBuf::from(crate::adapter::psx_launch_path(project_root)?);
    run_pinned_builder(
        python,
        &project_root,
        toolchain_root,
        std::iter::once(crate::adapter::psx_launch_path(cli)?).chain(arguments),
        operation,
        quiesced,
    )
}

fn run_pinned_builder(
    executable: &Path,
    project_root: &Path,
    toolchain_root: &Path,
    arguments: impl IntoIterator<Item = String>,
    operation: &OperationCoordinator,
    quiesced: &mut bool,
) -> Result<()> {
    capture_pinned_builder(
        executable,
        project_root,
        toolchain_root,
        arguments,
        operation,
        quiesced,
        false,
    )
    .map(|_| ())
}

fn capture_pinned_builder(
    executable: &Path,
    project_root: &Path,
    toolchain_root: &Path,
    arguments: impl IntoIterator<Item = String>,
    operation: &OperationCoordinator,
    quiesced: &mut bool,
    owned_ninja: bool,
) -> Result<crate::ActivityDiagnostic> {
    operation.checkpoint()?;
    // Refuse unsupported command-shell paths before profile creation or tools.
    let command_directory = builder_path(&if owned_ninja {
        project_root.join("build-portcove")
    } else {
        project_root.to_path_buf()
    })?;
    let platform = Platform::current()?;
    if !validate_toolchain_with_checkpoint(
        toolchain_root,
        platform,
        toolchain_artifact(platform)?,
        || operation.checkpoint(),
    )? || ![
        toolchain_python(toolchain_root)?,
        platform_executable(&toolchain_root.join("bin"), "cmake"),
        platform_executable(&toolchain_root.join("bin"), "ninja"),
    ]
    .iter()
    .any(|allowed| allowed == executable)
    {
        return Err(PortcoveError::verification(
            "managed PS1 builder requires its unchanged pinned toolchain",
        ));
    }
    let environment_root = project_root.join(".portcove-builder-environment");
    crate::path::refuse_symlink_ancestors(&environment_root)?;
    for directory in [
        "home",
        "cache",
        "data",
        "config",
        "temp",
        "appdata",
        "localappdata",
    ] {
        let path = environment_root.join(directory);
        crate::path::refuse_symlink_ancestors(&path)?;
        fs::create_dir_all(path)?;
    }
    let path = std::env::join_paths([
        toolchain_root.join("bin"),
        toolchain_python(toolchain_root)?
            .parent()
            .expect("bundled Python has a parent")
            .to_path_buf(),
    ])
    .map_err(|_| PortcoveError::verification("pinned PS1 toolchain PATH is invalid"))?;
    let mut command =
        ChildProcessPolicy::native_tool_spec(ChildProcessClass::ManagedBuilder, executable)?;
    command
        .args(arguments)
        .current_dir(command_directory)
        .env("RETCOMM_TOOLCHAIN_DIR", toolchain_root)
        .env("PSXRECOMP_TOOLCHAIN_DIR", toolchain_root)
        .env(
            "PSXRECOMP_GAME",
            platform_executable(
                &project_root.join("psxrecomp/recompiler/build"),
                "psxrecomp-game",
            ),
        )
        .env(
            "PSXRECOMP_BIOS",
            platform_executable(
                &project_root.join("psxrecomp/recompiler/build"),
                "psxrecomp-bios",
            ),
        )
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .env_remove("LD_LIBRARY_PATH")
        .env_remove("DYLD_LIBRARY_PATH")
        .env_remove("HOMEDRIVE")
        .env_remove("HOMEPATH")
        .env("PATH", path)
        .env("HOME", environment_root.join("home"))
        .env("USERPROFILE", environment_root.join("home"))
        .env("APPDATA", environment_root.join("appdata"))
        .env("LOCALAPPDATA", environment_root.join("localappdata"))
        .env("XDG_CACHE_HOME", environment_root.join("cache"))
        .env("XDG_DATA_HOME", environment_root.join("data"))
        .env("XDG_CONFIG_HOME", environment_root.join("config"))
        .env(
            "RETCOMM_TOOLCHAIN_CACHE",
            environment_root.join("cache/retcomm"),
        )
        .env("RETCOMM_DATA_HOME", environment_root.join("data/retcomm"))
        .env("TEMP", environment_root.join("temp"))
        .env("TMP", environment_root.join("temp"))
        .env("TMPDIR", environment_root.join("temp"));
    if owned_ninja {
        if executable != platform_executable(&toolchain_root.join("bin"), "ninja") {
            return Err(PortcoveError::verification(
                "owned compile stage requires pinned Ninja",
            ));
        }
        command.env("NINJA_STATUS", pending::STATUS);
    }
    let previous_quiescence = *quiesced;
    *quiesced = false;
    let mut command_quiesced = false;
    let mut captured = None;
    let output = crate::tool_process::run_tool(
        &mut command,
        &|| operation.checkpoint(),
        crate::tool_process::ToolProcessObserver {
            diagnostics: Some(crate::tool_process::ToolDiagnosticSink {
                activity_id: operation.operation_id(),
                phase: "install.ps1.builder",
                record: &mut |snapshot| {
                    captured = Some(snapshot.clone());
                    Ok(())
                },
            }),
            quiesced: Some(&mut || {
                command_quiesced = true;
                Ok(())
            }),
        },
    );
    *quiesced = previous_quiescence && command_quiesced;
    let output = output.map_err(builder_supervision_error)?;
    if output.status.success() {
        return captured.ok_or_else(|| PortcoveError::state("builder final capture missing"));
    }
    // Preserve the builder's stderr/stdout failure ordering while using the
    // existing bounded, redacted per-stream capture, not unbounded output().
    let captured = captured.expect("supervisor provides final builder capture");
    let mut detail = captured
        .stderr
        .text
        .lines()
        .chain(captured.stdout.text.lines())
        .rev()
        .take(20)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n");
    let mut end = detail.len().min(64 * 1024);
    while !detail.is_char_boundary(end) {
        end -= 1;
    }
    let truncated = captured.stdout.truncated || captured.stderr.truncated || end < detail.len();
    detail.truncate(end);
    Err(
        PortcoveError::install(format!("PS1 builder exited with {}", output.status))
            .detail("output_tail", detail)
            .detail("output_truncated", truncated.to_string()),
    )
}

fn toolchain_artifact(platform: Platform) -> Result<ToolchainArtifact> {
    match platform {
        Platform::WindowsX86_64 => Ok(ToolchainArtifact {
            name: "cmake-clang-v1-windows-x64.zip",
            size: 209_497_009,
            sha256: "28da9742385e7ff875b3d9311e8ed89dbdc84f27b6ecba2bc0d0acc11f6d2b4d",
        }),
        Platform::LinuxX86_64 => Ok(ToolchainArtifact {
            name: "cmake-clang-v1-linux-x64.zip",
            size: 833_435_449,
            sha256: "597c8d343a3cf02ba6f6b2ae7cf6fe2fef125dde8feff62a144e8dd3da3d484e",
        }),
        Platform::MacosX86_64 | Platform::MacosAarch64 => Ok(ToolchainArtifact {
            name: "cmake-clang-v1-macos-universal.zip",
            size: 95_921_806,
            sha256: "9db2a9b6ede4162cb19850ee1a08d01147f3ea8bc9b2eefb3ffbdf8b20d389d7",
        }),
    }
}

fn validate_toolchain(
    root: &Path,
    platform: Platform,
    artifact: ToolchainArtifact,
) -> Result<bool> {
    validate_toolchain_with_checkpoint(root, platform, artifact, || Ok(()))
}

fn validate_toolchain_with_checkpoint(
    root: &Path,
    platform: Platform,
    artifact: ToolchainArtifact,
    mut checkpoint: impl FnMut() -> Result<()>,
) -> Result<bool> {
    checkpoint()?;
    crate::path::refuse_symlink_ancestors(root)?;
    let marker_path = root.join(".portcove-toolchain.json");
    crate::path::refuse_symlink_ancestors(&marker_path)?;
    if !marker_path.is_file() {
        return Ok(false);
    }
    // Four critical identities fit comfortably within this metadata-only limit.
    let marker: ToolchainMarker =
        serde_json::from_slice(&crate::path::read_bounded_regular(&marker_path, 64 * 1024)?)?;
    if marker.schema_version != 2
        || marker.version != TOOLCHAIN_VERSION
        || marker.platform != platform
        || marker.asset_name != artifact.name
        || !marker.sha256.eq_ignore_ascii_case(artifact.sha256)
    {
        return Ok(false);
    }
    let Ok(python) = toolchain_python(root) else {
        return Ok(false);
    };
    let paths = [
        python,
        platform_executable(&root.join("bin"), "cmake"),
        platform_executable(&root.join("bin"), "ninja"),
        root.join("retcomm-toolchain.json"),
    ];
    if marker.critical_files.len() != paths.len() {
        return Ok(false);
    }
    for path in paths {
        checkpoint()?;
        crate::path::refuse_symlink_ancestors(&path)?;
        let relative = path
            .strip_prefix(root)
            .map_err(|_| PortcoveError::verification("toolchain file escaped its root"))?
            .to_string_lossy()
            .replace('\\', "/");
        let mut matches = marker
            .critical_files
            .iter()
            .filter(|file| file.path == relative);
        let Some(recorded) = matches.next() else {
            return Ok(false);
        };
        if matches.next().is_some() {
            return Ok(false);
        }
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            return Ok(false);
        };
        if !metadata.is_file() || metadata.len() != recorded.size {
            return Ok(false);
        }
        let (sha256, size) = crate::adapter::hash_file_bounded_with_checkpoint(
            &path,
            recorded.size,
            &mut checkpoint,
        )?;
        if size != recorded.size || sha256 != recorded.sha256 {
            return Ok(false);
        }
    }
    Ok(true)
}

fn toolchain_file_identities(
    root: &Path,
    _platform: Platform,
) -> Result<Vec<ToolchainFileIdentity>> {
    let paths = [
        toolchain_python(root)?,
        platform_executable(&root.join("bin"), "cmake"),
        platform_executable(&root.join("bin"), "ninja"),
        root.join("retcomm-toolchain.json"),
    ];
    let mut identities = Vec::with_capacity(paths.len());
    for path in paths {
        if !path.is_file() {
            return Err(PortcoveError::verification(format!(
                "PS1 toolchain is missing a critical file: {}",
                path.display()
            )));
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|_| PortcoveError::verification("toolchain file escaped its root"))?
            .to_str()
            .ok_or_else(|| PortcoveError::verification("toolchain path is not Unicode"))?
            .replace('\\', "/");
        let (sha256, size) = hash_file(&path)?;
        identities.push(ToolchainFileIdentity {
            path: relative,
            size,
            sha256,
        });
    }
    identities.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(identities)
}

fn toolchain_python(root: &Path) -> Result<PathBuf> {
    let candidates = if cfg!(windows) {
        vec![root.join("python").join("python.exe")]
    } else {
        vec![
            root.join("python").join("bin").join("python3"),
            root.join("python").join("bin").join("python"),
        ]
    };
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| {
            PortcoveError::verification("PS1 toolchain is missing its bundled Python runtime")
        })
}

fn platform_executable(root: &Path, basename: &str) -> PathBuf {
    if cfg!(windows) {
        root.join(format!("{basename}.exe"))
    } else {
        root.join(basename)
    }
}

fn locate_pack_root(unpacked: &Path) -> Result<PathBuf> {
    if unpacked.join("retcomm-toolchain.json").is_file() {
        return Ok(unpacked.to_path_buf());
    }
    let mut directories = fs::read_dir(unpacked)?
        .filter_map(std::result::Result::ok)
        .filter(|entry| entry.path().is_dir())
        .map(|entry| entry.path());
    let candidate = directories.next().ok_or_else(|| {
        PortcoveError::verification("toolchain ZIP did not contain a package root")
    })?;
    if directories.next().is_some() || !candidate.join("retcomm-toolchain.json").is_file() {
        return Err(PortcoveError::verification(
            "toolchain ZIP has an unsupported package layout",
        ));
    }
    Ok(candidate)
}

// Inert first-party fixture shared only by this repair's three inline suites.
#[cfg(test)]
pub(crate) fn bios_launch_fixture(
    root: &Path,
) -> (Library, crate::Catalog, crate::InstallRecord, SourceRecord) {
    let library = Library::open(root.join("library")).unwrap();
    let path = root.join("original.BIN");
    fs::write(&path, b"inert owned BIOS fixture").unwrap();
    let (digest, size) = hash_file(&path).unwrap();
    let bios = SourceRecord {
        profile_id: "psx-scph-1001-bios".into(),
        path,
        sha256: digest.clone(),
        size,
        storage_sha256: digest.clone(),
        storage_size: size,
        updated_at: Library::now(),
        observed_identity: None,
    };
    let mut document =
        serde_json::to_value(crate::Catalog::embedded().unwrap().authoritative_document()).unwrap();
    let asset = document["source_catalog"]["identities"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|asset| asset["id"] == bios.profile_id)
        .unwrap();
    let identity = &mut asset["variants"][0]["representations"][0]["identities"][0];
    identity["sha1"] = serde_json::Value::Null;
    identity["sha256"] = digest.into();
    let catalog = crate::Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap();
    let port = catalog.port("mortal-kombat-4-recompiled").unwrap();
    let install_root = root.join("install");
    let runtime = install_root.join("build-portcove");
    fs::create_dir_all(&runtime).unwrap();
    fs::write(
        runtime.join("Mortal_Kombat_4.exe"),
        b"inert executable bytes",
    )
    .unwrap();
    fs::write(runtime.join("game.toml"), "[game]\nname = 'fixture'\n").unwrap();
    fs::write(
        install_root.join(".portcove-managed.json"),
        serde_json::to_vec(&ManagedMarker {
            schema_version: 1,
            adapter: "psx-recomp-managed",
            source_sha256: "unused-fixture-disc",
            source_storage_sha256: "unused-fixture-disc",
            bios_source_sha256: Some(&bios.sha256),
            toolchain_version: TOOLCHAIN_VERSION,
        })
        .unwrap(),
    )
    .unwrap();
    let artifact = crate::ArtifactIdentity {
        asset_name: "owned-fixture.zip".into(),
        sha256: "0".repeat(64),
        size: 16,
    };
    let qualification =
        crate::InstallQualification::from_catalog(&catalog, &port.id, Platform::WindowsX86_64)
            .unwrap();
    let (manifest_sha256, selected_executable, runtime) = crate::Installer::new(library.clone())
        .unwrap()
        .create_manifest(
            "bios-fixture-install",
            &port.id,
            "fixture",
            &artifact,
            &qualification,
            &install_root,
        )
        .unwrap();
    let install = crate::InstallRecord {
        id: "bios-fixture-install".into(),
        port_id: port.id.clone(),
        version: "fixture".into(),
        path: install_root,
        channel: crate::ReleaseChannel::Stable,
        installed_at: Library::now(),
        verified: true,
        staged: false,
        artifact,
        runtime,
        manifest_sha256,
        selected_executable,
    };
    library.register_install(&install, true).unwrap();
    library.register_source(&bios).unwrap();
    (library, catalog, install, bios)
}

#[cfg(test)]
mod tests {
    #[test]
    fn builder_error_mapping_preserves_bounded_proof_without_other_details() {
        let error = super::builder_supervision_error(
            crate::PortcoveError::launch("completion observation failed")
                .detail("process_tree_first_failure", "member_wait")
                .detail("process_tree_api_error", "6")
                .detail("process_tree_wait_result", "4294967295")
                .detail("unrelated_private_detail", "must not propagate"),
        );
        assert_eq!(error.code, crate::ErrorCode::Install);
        assert!(error.message.contains("could not run PS1 builder"));
        assert_eq!(error.details["process_tree_first_failure"], "member_wait");
        assert_eq!(error.details["process_tree_api_error"], "6");
        assert_eq!(error.details["process_tree_wait_result"], "4294967295");
        assert!(!error.details.contains_key("process_tree_active"));
        assert!(!error.details.contains_key("unrelated_private_detail"));
        let cancelled = super::builder_supervision_error(
            crate::PortcoveError::new(crate::ErrorCode::Cancelled, "cancelled")
                .detail("operation_id", "retained-operation"),
        );
        assert_eq!(cancelled.code, crate::ErrorCode::Cancelled);
        assert_eq!(cancelled.details["operation_id"], "retained-operation");
    }

    use super::*;
    use sha2::Digest;
    use std::{
        thread,
        time::{Duration, Instant},
    };

    fn bios_fixture(path: &Path) -> SourceRecord {
        fs::write(path, b"inert owned BIOS fixture").unwrap();
        let (digest, size) = hash_file(path).unwrap();
        SourceRecord {
            profile_id: "owned-bios".into(),
            path: path.into(),
            sha256: digest.clone(),
            size,
            storage_sha256: digest,
            storage_size: size,
            updated_at: Library::now(),
            observed_identity: None,
        }
    }

    #[test]
    fn managed_bios_cleanup_uses_regional_profile_and_preserves_originals() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("package");
        let directory = root.join("psxrecomp/bios");
        fs::create_dir_all(&directory).unwrap();
        let original = bios_fixture(&temporary.path().join("original.BIN"));
        for (game, profile, expected) in [
            (
                "offsets = [\n [1, 2],\n [3, 4]\n]\n[[unrelated]]\nname = 'fixture'\n[recompiler]\nbios_config = 'psxrecomp/bios/SCPH5552.toml'\n",
                "SCPH5552.toml",
                "SCPH5552.BIN",
            ),
            (
                "[game]\nname = 'default'\n",
                "SCPH1001.toml",
                "SCPH1001.BIN",
            ),
            (
                "[recompiler]\nbios_config = 'psxrecomp/bios/custom.toml'\n",
                "custom.toml",
                "regional.BIN",
            ),
        ] {
            fs::write(root.join("game.toml"), game).unwrap();
            let body = if profile == "custom.toml" {
                "[recompiler]\nout_stem = 'ignored'\n[recompiler.address_model]\nmask = 'fixture'\n[[recompiler.address_model.copy]]\nname = 'one'\n[[recompiler.address_model.copy]]\nname = 'two'\n[program]\nrom = 'bios/regional.BIN'\n"
            } else {
                "[program]\nid = 'fixture'\n"
            };
            fs::write(directory.join(profile), body).unwrap();
            let staged = staged_bios_path(&root).unwrap();
            assert_eq!(staged, directory.join(expected));
            fs::copy(&original.path, &staged).unwrap();
            fs::write(directory.join("unrelated.BIN"), b"unrelated").unwrap();
            remove_staged_bios(&staged, &original, &|| Ok(())).unwrap();
            assert!(!staged.exists());
            assert_eq!(
                fs::read(&original.path).unwrap(),
                b"inert owned BIOS fixture"
            );
            assert_eq!(
                fs::read(directory.join("unrelated.BIN")).unwrap(),
                b"unrelated"
            );
        }
        assert!(remove_staged_bios(&original.path, &original, &|| Ok(())).is_err());
        assert!(original.path.is_file());
    }

    #[test]
    fn managed_bios_cleanup_refuses_wrong_copy_replaced_original_and_cancellation() {
        let temporary = tempfile::tempdir().unwrap();
        let original = bios_fixture(&temporary.path().join("original.BIN"));
        let staged = temporary.path().join("staged.BIN");
        fs::write(&staged, b"wrong").unwrap();
        assert!(remove_staged_bios(&staged, &original, &|| Ok(())).is_err());
        fs::copy(&original.path, &staged).unwrap();
        let cancelled = || {
            Err(PortcoveError::new(
                crate::ErrorCode::Cancelled,
                "fixture cancellation",
            ))
        };
        assert_eq!(
            remove_staged_bios(&staged, &original, &cancelled)
                .unwrap_err()
                .code,
            crate::ErrorCode::Cancelled
        );
        fs::write(&original.path, b"replaced").unwrap();
        assert!(remove_staged_bios(&staged, &original, &|| Ok(())).is_err());
        assert!(staged.is_file());
        assert_eq!(fs::read(&original.path).unwrap(), b"replaced");
    }

    #[test]
    fn managed_bios_cleanup_rechecks_the_copy_after_final_checkpoint() {
        let temporary = tempfile::tempdir().unwrap();
        let original = bios_fixture(&temporary.path().join("original.BIN"));
        let staged = temporary.path().join("staged.BIN");
        fs::copy(&original.path, &staged).unwrap();
        let calls = std::cell::Cell::new(0);
        let checkpoint = || {
            calls.set(calls.get() + 1);
            if calls.get() == 3 {
                fs::write(&staged, b"replacement at cleanup checkpoint")?;
            }
            Ok(())
        };
        assert!(remove_staged_bios(&staged, &original, &checkpoint).is_err());
        assert_eq!(
            fs::read(&staged).unwrap(),
            b"replacement at cleanup checkpoint"
        );
        assert_eq!(
            fs::read(&original.path).unwrap(),
            b"inert owned BIOS fixture"
        );
    }

    #[test]
    fn managed_bios_coordinates_reject_unsafe_and_ambiguous_paths() {
        let temporary = tempfile::tempdir().unwrap();
        let directory = temporary.path().join("psxrecomp/bios");
        fs::create_dir_all(&directory).unwrap();
        for game in [
            "[recompiler]\nbios_config = '../original.toml'\n",
            "[recompiler]\nbios_config = 'psxrecomp/other.toml'\n",
            "[recompiler]\nbios_config = 'psxrecomp/bios/a.toml'\nbios_config = 'psxrecomp/bios/b.toml'\n",
            "recompiler.bios_config = 'psxrecomp/bios/a.toml'\n",
        ] {
            fs::write(temporary.path().join("game.toml"), game).unwrap();
            assert!(staged_bios_path(temporary.path()).is_err());
        }
        fs::write(
            temporary.path().join("game.toml"),
            "[game]\nname = 'fixture'\n",
        )
        .unwrap();
        for rom in [
            "../original.BIN",
            "bios/../original.BIN",
            "/original.BIN",
            "other/original.BIN",
        ] {
            fs::write(
                directory.join("SCPH1001.toml"),
                format!("[program]\nrom = '{rom}'\n"),
            )
            .unwrap();
            assert!(staged_bios_path(temporary.path()).is_err());
        }
    }

    #[test]
    fn managed_bios_refuses_containers_and_missing_or_replaced_files() {
        let temporary = tempfile::tempdir().unwrap();
        let original = bios_fixture(&temporary.path().join("original.BIN"));
        let mut container = original.clone();
        container.storage_sha256 = "0".repeat(64);
        assert_eq!(
            verify_raw_bios(&container, &|| Ok(())).unwrap_err().code,
            crate::ErrorCode::Unsupported
        );
        fs::write(&original.path, b"replaced").unwrap();
        assert!(verify_raw_bios(&original, &|| Ok(())).is_err());
        fs::remove_file(&original.path).unwrap();
        assert!(verify_raw_bios(&original, &|| Ok(())).is_err());
    }

    #[test]
    #[cfg(unix)]
    fn managed_bios_refuses_symlinked_cleanup_and_source_coordinates() {
        use std::os::unix::fs::symlink;
        let temporary = tempfile::tempdir().unwrap();
        let original = bios_fixture(&temporary.path().join("original.BIN"));
        let link = temporary.path().join("link.BIN");
        symlink(&original.path, &link).unwrap();
        assert!(remove_staged_bios(&link, &original, &|| Ok(())).is_err());
        let mut aliased = original.clone();
        aliased.path = link;
        assert!(verify_raw_bios(&aliased, &|| Ok(())).is_err());
        let root = temporary.path().join("package");
        fs::create_dir_all(root.join("psxrecomp")).unwrap();
        symlink(temporary.path(), root.join("psxrecomp/bios")).unwrap();
        fs::write(root.join("game.toml"), "[game]\nname = 'fixture'\n").unwrap();
        fs::write(
            temporary.path().join("SCPH1001.toml"),
            "[program]\nid = 'fixture'\n",
        )
        .unwrap();
        assert!(staged_bios_path(&root).is_err());
        assert_eq!(
            fs::read(&original.path).unwrap(),
            b"inert owned BIOS fixture"
        );
    }

    fn preparation_input_fixture(root: &Path, multi_disc: bool) -> PsxManagedPreparation {
        let source_path = if multi_disc {
            let directory = root.join("owned-discs");
            fs::create_dir(&directory).unwrap();
            for name in ["disc-01.chd", "disc-02.chd"] {
                fs::write(directory.join(name), name.as_bytes()).unwrap();
            }
            directory
        } else {
            let file = root.join("owned-disc.chd");
            fs::write(&file, b"inert owned disc bytes").unwrap();
            file
        };
        let (storage_sha256, storage_size) =
            crate::adapter::source_storage_identity(&source_path).unwrap();
        let source_paths =
            crate::adapter::psx_source_paths(&source_path, if multi_disc { 2 } else { 1 }).unwrap();
        PsxManagedPreparation {
            source: SourceRecord {
                profile_id: "owned-ps1-disc".into(),
                path: source_path,
                sha256: storage_sha256.clone(),
                size: storage_size,
                storage_sha256,
                storage_size,
                updated_at: Library::now(),
                observed_identity: None,
            },
            bios: None,
            source_paths,
            runtime_source_directory: None,
            toolchain_root: root.join("absent-owned-toolchain"),
            executable_basename: "owned-game".into(),
        }
    }

    fn assert_invalid_preparation_input(
        root: &Path,
        preparation: &PsxManagedPreparation,
        field: &str,
    ) {
        let staging = root.join("owned-staging");
        fs::create_dir_all(&staging).unwrap();
        fs::write(staging.join("preserve"), b"preserve private bytes").unwrap();
        let identity = crate::adapter::source_storage_identity(&preparation.source.path).unwrap();
        let (result, quiesced) = prepare_install(
            &staging,
            preparation,
            &OperationCoordinator::new("owned-input-validation", None),
        );
        let error = result.unwrap_err();
        assert_eq!(
            error.details.get("preparation_field").map(String::as_str),
            Some(field),
            "unexpected refusal: {error:?}"
        );
        assert!(quiesced);
        assert_eq!(
            fs::read(staging.join("preserve")).unwrap(),
            b"preserve private bytes"
        );
        assert_eq!(fs::read_dir(&staging).unwrap().count(), 1);
        assert_eq!(
            crate::adapter::source_storage_identity(&preparation.source.path).unwrap(),
            identity
        );
    }

    #[test]
    fn generation_witness_join_fence_refuses_drift_after_output_hashing() {
        use std::sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
            mpsc,
        };
        use std::time::Duration;
        for kind in ["output-file", "output-name", "toolchain-file", "disc-file"] {
            let root = tempfile::tempdir().unwrap();
            let (library, operation, journal, witness, _) = generation_witness_fixture(root.path());
            let (entered_tx, entered_rx) = mpsc::channel();
            let (release_tx, release_rx) = mpsc::channel();
            let mutated = Arc::new(AtomicBool::new(false));
            let observed = mutated.clone();
            let result = witness.verify_fenced(
                &library,
                &journal,
                &operation,
                move || {
                    entered_tx.send(()).unwrap();
                    release_rx.recv_timeout(Duration::from_secs(2)).unwrap();
                    Ok(())
                },
                || {
                    // Both complete content checks have run, but the input
                    // worker is still held. This mutation cannot be concealed
                    // by the owner check or the later durable-row SQL fence.
                    entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
                    if kind == "output-name" {
                        fs::write(witness.generated.tree.root().join("inserted.c"), "inserted")?;
                    } else {
                        let path = match kind {
                            "output-file" => witness.generated.tree.root().join("generated.c"),
                            "toolchain-file" => witness
                                .generated
                                .toolchain
                                .root()
                                .join("bin")
                                .join(if cfg!(windows) { "cmake.exe" } else { "cmake" }),
                            "disc-file" => {
                                witness.generated.normalized_disc.root().join("disc.bin")
                            }
                            _ => unreachable!(),
                        };
                        let modified = fs::metadata(&path)?.modified()?;
                        let mut bytes = fs::read(&path)?;
                        bytes[0] ^= 1;
                        fs::write(&path, bytes)?;
                        // Make the metadata drift deterministic even on a
                        // coarse-timestamp filesystem; size remains unchanged.
                        fs::File::options().write(true).open(path)?.set_times(
                            fs::FileTimes::new().set_modified(modified + Duration::from_secs(1)),
                        )?;
                    }
                    observed.store(true, Ordering::SeqCst);
                    release_tx.send(()).unwrap();
                    Ok(())
                },
            );
            assert!(
                mutated.load(Ordering::SeqCst),
                "mutation was not reached: {kind}"
            );
            assert!(result.is_err(), "post-hash drift was admitted: {kind}");
            let rows: i64 = library
                .connection()
                .unwrap()
                .query_row("SELECT count(*) FROM managed_psx_generation", [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(rows, 0);
            assert!(!journal.paths.final_path.as_ref().unwrap().exists());
        }
    }

    fn generation_witness_fixture(
        root: &Path,
    ) -> (
        Library,
        OperationCoordinator,
        crate::operation::LifecycleOperation,
        GeneratedInstallWitness,
        PsxManagedPreparation,
    ) {
        use crate::operation::{LifecycleOperation, LifecycleOperationKind, OperationStore};
        let library = Library::open(root.join("library")).unwrap();
        let operation = OperationCoordinator::new("inert-generation-witness", None);
        let mut journal = LifecycleOperation::new(
            operation.operation_id(),
            LifecycleOperationKind::Install,
            "inert-port",
        );
        journal.phase = crate::operation::LifecyclePhase::StagedPreparing;
        let staging = library.staging_dir().join(operation.operation_id());
        let payload = staging.join("payload");
        let normalized = staging.join("psx-source-inert");
        fs::create_dir_all(&payload).unwrap();
        fs::create_dir_all(&normalized).unwrap();
        fs::write(payload.join("generated.c"), "inert generated source").unwrap();
        fs::write(
            payload.join("game.toml"),
            "[game]\nname='inert fixture'\ndisc='initial.cue'\n",
        )
        .unwrap();
        fs::create_dir(payload.join("disc")).unwrap();
        fs::write(payload.join("disc/owned.bin"), "inert generated disc copy").unwrap();
        fs::write(normalized.join("disc.bin"), "inert normalized disc").unwrap();
        let mut preparation = preparation_input_fixture(root, false);
        preparation.toolchain_root = root.join("inert-toolchain");
        toolchain_fixture(&preparation.toolchain_root, None);
        for name in ["clang", "clang++"] {
            fs::write(
                platform_executable(&preparation.toolchain_root.join("bin"), name),
                "inert compiler; not executed",
            )
            .unwrap();
        }
        journal.paths.staging = Some(staging);
        journal.paths.final_path = Some(root.join("unpublished-install"));
        journal.preparation_process_quiesced = Some(true);
        OperationStore::new(library.clone())
            .put(&mut journal)
            .unwrap();
        // Inert storage/control fixture: no generator or game has executed.
        let generated = GeneratedInstall {
            tree: stage::GeneratedTree::capture(&payload, &operation, true).unwrap(),
            toolchain: stage::GeneratedTree::capture(&preparation.toolchain_root, &operation, true)
                .unwrap(),
            normalized_disc: stage::GeneratedTree::capture(&normalized, &operation, true).unwrap(),
            inputs: preparation_identity(&preparation).unwrap(),
            generation_arguments: vec!["inert fixture; not executed".into()],
            staged_bios: None,
        };
        let witness = GeneratedInstallWitness::new(
            &library,
            &journal,
            serde_json::json!({"inert":true}),
            generated,
        )
        .unwrap();
        (library, operation, journal, witness, preparation)
    }

    fn bootstrap_fixture(
        root: &Path,
    ) -> (
        Library,
        OperationCoordinator,
        crate::operation::LifecycleOperation,
        BootstrapWitness,
        GeneratedInstallWitness,
        PsxManagedPreparation,
    ) {
        let (library, operation, journal, generated, preparation) =
            generation_witness_fixture(root);
        let bytes = b"inert authenticated archive fixture";
        fs::write(
            journal
                .paths
                .staging
                .as_ref()
                .unwrap()
                .join("artifact.download"),
            bytes,
        )
        .unwrap();
        use sha2::Digest;
        let artifact = crate::ArtifactIdentity {
            asset_name: "inert.zip".into(),
            sha256: hex::encode(sha2::Sha256::digest(bytes)),
            size: bytes.len() as u64,
        };
        let witness = BootstrapWitness::capture(
            &library,
            &journal,
            serde_json::json!({"inert": true}),
            &preparation,
            artifact,
            &operation,
        )
        .unwrap();
        (library, operation, journal, witness, generated, preparation)
    }

    #[test]
    fn bootstrap_reopen_grants_no_generation_and_rejects_changed_archive() {
        use crate::operation::OperationStore;
        let temporary = tempfile::tempdir().unwrap();
        let (library, operation, journal, witness, _, _) = bootstrap_fixture(temporary.path());
        let store = OperationStore::new(library.clone());
        store
            .commit_psx_bootstrap(&journal, &witness, &operation)
            .unwrap();
        let reopened = Library::open(library.root()).unwrap();
        OperationStore::new(reopened)
            .psx_bootstrap(&operation)
            .unwrap();
        assert!(store.psx_generation(&operation).is_err());
        assert!(library.all_installs().unwrap().is_empty());
        fs::write(
            journal
                .paths
                .staging
                .as_ref()
                .unwrap()
                .join("artifact.download"),
            b"changed archive",
        )
        .unwrap();
        assert!(store.psx_bootstrap(&operation).is_err());
    }

    fn normalized_input_fixture(
        root: &Path,
    ) -> (
        Library,
        OperationCoordinator,
        crate::operation::LifecycleOperation,
        NormalizedInputWitness,
        PsxManagedPreparation,
    ) {
        let (library, operation, journal, bootstrap, _, preparation) = bootstrap_fixture(root);
        let store = crate::operation::OperationStore::new(library.clone());
        store
            .commit_psx_bootstrap(&journal, &bootstrap, &operation)
            .unwrap();
        let loaded = store.psx_bootstrap(&operation).unwrap();
        let disc = journal
            .paths
            .staging
            .as_ref()
            .unwrap()
            .join("psx-source-inert");
        fs::write(
            disc.join("disc.cue"),
            "inert cue descriptor; no helper executed",
        )
        .unwrap();
        let helper = root.join("inert-chd-helper");
        fs::write(&helper, "inert helper; not executed").unwrap();
        let witness =
            NormalizedInputWitness::inert_fixture(loaded, &preparation, &disc, &helper, &operation)
                .unwrap();
        (library, operation, journal, witness, preparation)
    }

    fn normalized_generation_fixture(
        root: &Path,
    ) -> (
        Library,
        OperationCoordinator,
        crate::operation::LifecycleOperation,
        NormalizedInputWitness,
        PsxManagedPreparation,
    ) {
        let (library, operation, journal, _, mut preparation) = generation_witness_fixture(root);
        preparation.bios = None;
        let payload = journal.paths.staging.as_ref().unwrap().join("payload");
        for directory in ["seeds", "psxrecomp/recompiler/build"] {
            fs::create_dir_all(payload.join(directory)).unwrap();
        }
        fs::write(payload.join("game.toml"), concat!(
            "[game]\nexe = 'disc/GAME.EXE'\n",
            "[prepare_disc]\nout_dir = 'disc'\nbin_name = 'disc.bin'\ncue_name = 'disc.cue'\nboot_exe = 'GAME.EXE'\n",
            "[recompiler]\nout_dir = 'generated'\nseeds = 'seeds/game.txt'\n",
            "[runtime]\nopenbios = false\n",
        )).unwrap();
        fs::write(payload.join("seeds/game.txt"), "immutable inert seeds").unwrap();
        fs::write(
            payload.join("psxrecomp/.gitignore"),
            "framework root marker",
        )
        .unwrap();
        for name in ["psxrecomp-game", "psxrecomp-bios"] {
            fs::write(
                platform_executable(&payload.join("psxrecomp/recompiler/build"), name),
                "inert emitter; never executed",
            )
            .unwrap();
        }
        let bytes = b"inert authenticated archive fixture";
        fs::write(
            journal
                .paths
                .staging
                .as_ref()
                .unwrap()
                .join("artifact.download"),
            bytes,
        )
        .unwrap();
        use sha2::Digest;
        let artifact = crate::ArtifactIdentity {
            asset_name: "inert.zip".into(),
            sha256: hex::encode(sha2::Sha256::digest(bytes)),
            size: bytes.len() as u64,
        };
        let bootstrap = BootstrapWitness::capture(
            &library,
            &journal,
            serde_json::json!({"inert":true}),
            &preparation,
            artifact,
            &operation,
        )
        .unwrap();
        let store = crate::operation::OperationStore::new(library.clone());
        store
            .commit_psx_bootstrap(&journal, &bootstrap, &operation)
            .unwrap();
        let disc = journal
            .paths
            .staging
            .as_ref()
            .unwrap()
            .join("psx-source-inert");
        fs::write(disc.join("disc.cue"), "inert cue; no helper executed").unwrap();
        let helper = root.join("inert-chd-helper");
        fs::write(&helper, "inert helper; never executed").unwrap();
        let normalized = NormalizedInputWitness::inert_fixture(
            store.psx_bootstrap(&operation).unwrap(),
            &preparation,
            &disc,
            &helper,
            &operation,
        )
        .unwrap();
        store
            .commit_psx_normalized_inputs(&journal, &normalized, &operation)
            .unwrap();
        let loaded = store.psx_normalized_inputs(&operation).unwrap();
        (library, operation, journal, loaded, preparation)
    }

    fn provisional_generation_fixture(
        root: &Path,
    ) -> (
        Library,
        OperationCoordinator,
        crate::operation::LifecycleOperation,
        ProvisionalGeneratedInstall,
        PsxManagedPreparation,
    ) {
        let (library, operation, journal, loaded, preparation) =
            normalized_generation_fixture(root);
        let candidate = loaded
            .inert_generated_fixture(&preparation, &operation)
            .unwrap();
        (library, operation, journal, candidate, preparation)
    }

    #[test]
    fn pending_generation_reopens_unverified_blocks_replay_and_seals_without_dispatch() {
        let temporary = tempfile::tempdir().unwrap();
        let (library, operation, journal, candidate, preparation) =
            provisional_generation_fixture(temporary.path());
        let store = crate::operation::OperationStore::new(library.clone());
        store
            .commit_psx_pending_generation(&journal, &candidate, &operation)
            .unwrap();
        assert!(store.psx_generation(&operation).is_err());
        assert!(store.psx_configuration(&operation).is_err());
        assert!(store.psx_inputs_for_generation(&operation).is_err());
        assert!(
            store
                .commit_psx_pending_generation(&journal, &candidate, &operation)
                .is_err()
        );
        assert!(library.all_installs().unwrap().is_empty());
        let reopened =
            crate::operation::OperationStore::new(Library::open(library.root()).unwrap());
        let decoded = reopened.psx_pending_generation(&operation).unwrap();
        decoded
            .require_request(&serde_json::json!({"inert":true}), &preparation)
            .unwrap();
        assert_eq!(decoded.artifact().asset_name, "inert.zip");
        reopened
            .seal_psx_generation(&journal, decoded, &operation)
            .unwrap();
        let loaded = reopened.psx_generation(&operation).unwrap();
        assert!(loaded.normalized_parent().is_some());
        assert!(loaded.bootstrap_parent().is_some());
        assert!(store.require_psx_generation_vacant(&operation).is_err());
        assert!(
            store
                .seal_psx_generation(
                    &journal,
                    store.psx_pending_generation(&operation).unwrap(),
                    &operation
                )
                .is_err()
        );
        assert!(library.all_installs().unwrap().is_empty());
        assert!(!journal.paths.final_path.as_ref().unwrap().exists());
        assert_eq!(
            library
                .connection()
                .unwrap()
                .query_row(
                    "SELECT count(*) FROM managed_psx_pending_generation",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
    }

    #[test]
    fn pending_generation_fences_exact_receipts_full_journal_and_library_after_hashing() {
        assert_pending_generation_fences(&[
            "pending",
            "normalized",
            "bootstrap",
            "created",
            "updated",
        ]);
    }

    #[test]
    fn pending_generation_fences_owner_closure_error_and_library_after_hashing() {
        assert_pending_generation_fences(&["activate", "quiesced", "error", "original", "library"]);
    }

    fn assert_pending_generation_fences(cases: &[&str]) {
        for &selected in cases {
            let temporary = tempfile::tempdir().unwrap();
            let (library, operation, journal, candidate, _) =
                provisional_generation_fixture(temporary.path());
            let store = crate::operation::OperationStore::new(library.clone());
            store
                .commit_psx_pending_generation(&journal, &candidate, &operation)
                .unwrap();
            let decoded = store.psx_pending_generation(&operation).unwrap();
            let result = store.seal_psx_generation_before_fence(&journal, decoded, &operation, || {
                let connection = library.connection()?;
                match selected {
                    "pending" => { connection.execute("UPDATE managed_psx_pending_generation SET witness_json=witness_json||' '", [])?; }
                    "normalized" => { connection.execute("UPDATE managed_psx_normalized_inputs SET witness_json=witness_json||' '", [])?; }
                    "bootstrap" => { connection.execute("UPDATE managed_psx_bootstrap SET witness_json=witness_json||' '", [])?; }
                    "created" => { connection.execute("UPDATE lifecycle_operations SET created_at=created_at+1", [])?; }
                    "updated" => { connection.execute("UPDATE lifecycle_operations SET updated_at=updated_at+1", [])?; }
                    "activate" => { connection.execute("UPDATE lifecycle_operations SET activate=1-activate", [])?; }
                    "quiesced" => { connection.execute("UPDATE lifecycle_operations SET preparation_process_quiesced=0", [])?; }
                    "error" => { connection.execute("UPDATE lifecycle_operations SET last_error='inert failure'", [])?; }
                    "original" => { connection.execute("UPDATE lifecycle_operations SET original_paths_json='[\"unowned\"]'", [])?; }
                    "library" => { connection.execute("UPDATE library_identity SET id='00000000000000000000000000000000'", [])?; }
                    _ => unreachable!(),
                }
                Ok(())
            });
            assert!(result.is_err(), "{selected}");
            assert_eq!(
                library
                    .connection()
                    .unwrap()
                    .query_row("SELECT count(*) FROM managed_psx_generation", [], |row| row
                        .get::<_, i64>(0))
                    .unwrap(),
                0,
                "{selected}"
            );
            assert!(!journal.paths.final_path.as_ref().unwrap().exists());
        }
    }

    #[test]
    fn pending_generation_restored_mtime_drift_refuses_promotion_retains_evidence() {
        for selected in [
            "output",
            "seed",
            "config",
            "cue",
            "archive",
            "helper",
            "source",
            "toolchain",
        ] {
            let temporary = tempfile::tempdir().unwrap();
            let (library, operation, journal, candidate, preparation) =
                provisional_generation_fixture(temporary.path());
            let store = crate::operation::OperationStore::new(library.clone());
            store
                .commit_psx_pending_generation(&journal, &candidate, &operation)
                .unwrap();
            let staging = journal.paths.staging.as_ref().unwrap();
            let path = match selected {
                "output" => staging.join("payload/generated/GAME.EXE_dispatch.c"),
                "seed" => staging.join("payload/seeds/game.txt"),
                "config" => staging.join("payload/game.toml"),
                "cue" => staging.join("psx-source-inert/disc.cue"),
                "archive" => staging.join("artifact.download"),
                "helper" => temporary.path().join("inert-chd-helper"),
                "source" => preparation.source.path.clone(),
                "toolchain" => {
                    platform_executable(&preparation.toolchain_root.join("bin"), "clang")
                }
                _ => unreachable!(),
            };
            let metadata = fs::metadata(&path).unwrap();
            let mut bytes = fs::read(&path).unwrap();
            bytes[0] ^= 1;
            fs::write(&path, bytes).unwrap();
            fs::File::options()
                .write(true)
                .open(&path)
                .unwrap()
                .set_times(fs::FileTimes::new().set_modified(metadata.modified().unwrap()))
                .unwrap();
            let decoded = store.psx_pending_generation(&operation).unwrap();
            assert!(
                store
                    .seal_psx_generation(&journal, decoded, &operation)
                    .is_err(),
                "{selected}"
            );
            assert_eq!(
                library
                    .connection()
                    .unwrap()
                    .query_row("SELECT count(*) FROM managed_psx_generation", [], |row| row
                        .get::<_, i64>(0))
                    .unwrap(),
                0
            );
            assert_eq!(
                library
                    .connection()
                    .unwrap()
                    .query_row(
                        "SELECT count(*) FROM managed_psx_pending_generation",
                        [],
                        |row| row.get::<_, i64>(0)
                    )
                    .unwrap(),
                1
            );
        }
    }

    #[test]
    #[cfg(feature = "qualification-fixtures")]
    fn pending_generation_schema_bounds_cascade_and_cancelled_seal_preserve_no_publication() {
        let temporary = tempfile::tempdir().unwrap();
        let (library, operation, journal, candidate, _) =
            provisional_generation_fixture(temporary.path());
        let store = crate::operation::OperationStore::new(library.clone());
        let connection = library.connection().unwrap();
        assert!(
            connection
                .execute(
                    "INSERT INTO managed_psx_pending_generation VALUES('unowned','{}',?1)",
                    ["a".repeat(64)]
                )
                .is_err()
        );
        assert!(
            connection
                .execute(
                    "INSERT INTO managed_psx_pending_generation VALUES(?1,'',?2)",
                    rusqlite::params![operation.operation_id(), "a".repeat(64)]
                )
                .is_err()
        );
        assert!(
            connection
                .execute(
                    "INSERT INTO managed_psx_pending_generation VALUES(?1,'{}','short')",
                    [operation.operation_id()]
                )
                .is_err()
        );
        store
            .commit_psx_pending_generation(&journal, &candidate, &operation)
            .unwrap();
        let decoded = store.psx_pending_generation(&operation).unwrap();
        let service = crate::PortcoveService::new(library.clone()).unwrap();
        let (activity, control) = service
            .begin_cancellable_activity(
                crate::ActivityOperation::Install,
                crate::ActivityTargetKind::Port,
                Some("inert-port"),
            )
            .unwrap();
        let cancellation =
            control.retained_child(operation.operation_id(), "seal-generation-cancel-control");
        service.request_cancellation(&activity.id).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(55));
        assert!(
            store
                .seal_psx_generation(&journal, decoded, &cancellation)
                .is_err()
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT count(*) FROM managed_psx_pending_generation",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        assert!(library.all_installs().unwrap().is_empty());
        store.remove(operation.operation_id()).unwrap();
        for table in [
            "managed_psx_bootstrap",
            "managed_psx_normalized_inputs",
            "managed_psx_pending_generation",
        ] {
            assert_eq!(
                connection
                    .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| row
                        .get::<_, i64>(0))
                    .unwrap(),
                0
            );
        }
        assert!(
            journal
                .paths
                .staging
                .as_ref()
                .unwrap()
                .join("payload/generated/GAME.EXE_dispatch.c")
                .is_file()
        );
    }

    #[test]
    fn materialized_inputs_reopen_as_unverified_and_seal_without_tool_dispatch() {
        let temporary = tempfile::tempdir().unwrap();
        let (library, operation, journal, witness, _) = normalized_input_fixture(temporary.path());
        let store = crate::operation::OperationStore::new(library.clone());
        store
            .commit_psx_materialized_inputs(&journal, &witness, &operation)
            .unwrap();
        assert!(store.psx_normalized_inputs(&operation).is_err());
        let reopened =
            crate::operation::OperationStore::new(Library::open(library.root()).unwrap());
        let decoded = reopened.psx_materialized_inputs(&operation).unwrap();
        reopened
            .seal_psx_materialized_inputs(&journal, decoded, &operation)
            .unwrap();
        assert!(reopened.psx_normalized_inputs(&operation).is_ok());
        let connection = library.connection().unwrap();
        for table in [
            "managed_psx_materialized_inputs",
            "managed_psx_normalized_inputs",
        ] {
            assert_eq!(
                connection
                    .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| row
                        .get::<_, i64>(0))
                    .unwrap(),
                1
            );
        }
        for table in [
            "managed_psx_generation",
            "managed_psx_configuration",
            "managed_psx_compilation",
            "installs",
        ] {
            assert_eq!(
                connection
                    .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| row
                        .get::<_, i64>(0))
                    .unwrap(),
                0
            );
        }
    }

    #[test]
    fn materialized_inputs_restored_mtime_content_drift_refuses_sealing() {
        for selected in ["cue", "helper", "payload", "archive", "source"] {
            let temporary = tempfile::tempdir().unwrap();
            let (library, operation, journal, witness, preparation) =
                normalized_input_fixture(temporary.path());
            let store = crate::operation::OperationStore::new(library.clone());
            store
                .commit_psx_materialized_inputs(&journal, &witness, &operation)
                .unwrap();
            let json: serde_json::Value =
                serde_json::from_str(&crate::operation::psx_witness_json(&witness).unwrap())
                    .unwrap();
            let staging = journal.paths.staging.as_ref().unwrap();
            let path = match selected {
                "cue" => PathBuf::from(json["cue"].as_str().unwrap()),
                "helper" => PathBuf::from(json["helper_path"].as_str().unwrap()),
                "payload" => staging.join("payload/game.toml"),
                "archive" => staging.join("artifact.download"),
                "source" => preparation.source.path.clone(),
                _ => unreachable!(),
            };
            let metadata = fs::metadata(&path).unwrap();
            let mut bytes = fs::read(&path).unwrap();
            assert!(!bytes.is_empty());
            bytes[0] ^= 1;
            fs::write(&path, bytes).unwrap();
            fs::File::options()
                .write(true)
                .open(&path)
                .unwrap()
                .set_times(fs::FileTimes::new().set_modified(metadata.modified().unwrap()))
                .unwrap();
            // Provisional loading deliberately grants no fresh-content authority.
            let decoded = store.psx_materialized_inputs(&operation).unwrap();
            assert!(
                store
                    .seal_psx_materialized_inputs(&journal, decoded, &operation)
                    .is_err(),
                "{selected}"
            );
            assert!(store.psx_normalized_inputs(&operation).is_err());
            assert_eq!(
                library
                    .connection()
                    .unwrap()
                    .query_row(
                        "SELECT count(*) FROM managed_psx_materialized_inputs",
                        [],
                        |row| row.get::<_, i64>(0)
                    )
                    .unwrap(),
                1
            );
        }
    }

    #[test]
    fn materialized_inputs_exact_pending_parent_and_journal_fenced_after_verification() {
        for selected in ["pending", "parent", "journal", "library"] {
            let temporary = tempfile::tempdir().unwrap();
            let (library, operation, journal, witness, _) =
                normalized_input_fixture(temporary.path());
            let store = crate::operation::OperationStore::new(library.clone());
            store
                .commit_psx_materialized_inputs(&journal, &witness, &operation)
                .unwrap();
            let decoded = store.psx_materialized_inputs(&operation).unwrap();
            let result = store.seal_psx_materialized_inputs_before_fence(&journal, decoded, &operation, || {
                let connection = library.connection()?;
                match selected {
                    "pending" => { connection.execute("UPDATE managed_psx_materialized_inputs SET witness_json=witness_json||' '", [])?; }
                    "parent" => { connection.execute("UPDATE managed_psx_bootstrap SET witness_json=witness_json||' '", [])?; }
                    "journal" => { connection.execute("UPDATE lifecycle_operations SET updated_at=updated_at+1 WHERE id=?1", [operation.operation_id()])?; }
                    "library" => { assert_eq!(connection.execute("UPDATE library_identity SET id=CASE WHEN id='00000000000000000000000000000000' THEN '11111111111111111111111111111111' ELSE '00000000000000000000000000000000' END", [])?, 1); }
                    _ => unreachable!(),
                }
                Ok(())
            });
            assert!(result.is_err(), "{selected}");
            assert_eq!(
                library
                    .connection()
                    .unwrap()
                    .query_row(
                        "SELECT count(*) FROM managed_psx_normalized_inputs",
                        [],
                        |row| row.get::<_, i64>(0)
                    )
                    .unwrap(),
                0
            );
        }
    }

    #[test]
    fn materialized_inputs_refuse_replay_and_direct_normalization_bypass() {
        let temporary = tempfile::tempdir().unwrap();
        let (library, operation, journal, witness, preparation) =
            normalized_input_fixture(temporary.path());
        let store = crate::operation::OperationStore::new(library.clone());
        store
            .commit_psx_materialized_inputs(&journal, &witness, &operation)
            .unwrap();
        assert!(
            store
                .commit_psx_materialized_inputs(&journal, &witness, &operation)
                .is_err()
        );
        assert!(store.require_psx_normalization_vacant(&operation).is_err());
        assert!(
            store
                .commit_psx_normalized_inputs(&journal, &witness, &operation)
                .is_err()
        );
        let bootstrap = store.psx_bootstrap(&operation).unwrap();
        let (result, quiesced) = bootstrap.generate(&library, &journal, &preparation, &operation);
        assert!(result.is_err());
        assert!(quiesced);
        assert!(store.psx_generation(&operation).is_err());
    }

    #[test]
    fn materialized_inputs_forged_candidate_cannot_become_normalized_authority() {
        use sha2::Digest;
        let temporary = tempfile::tempdir().unwrap();
        let (library, operation, journal, witness, _) = normalized_input_fixture(temporary.path());
        let store = crate::operation::OperationStore::new(library.clone());
        store
            .commit_psx_materialized_inputs(&journal, &witness, &operation)
            .unwrap();
        let mut value: serde_json::Value =
            serde_json::from_str(&crate::operation::psx_witness_json(&witness).unwrap()).unwrap();
        value["helper"]["sha256"] = serde_json::Value::String("0".repeat(64));
        let json = serde_json::to_string(&value).unwrap();
        let sha = hex::encode(sha2::Sha256::digest(json.as_bytes()));
        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE managed_psx_materialized_inputs SET witness_json=?1,witness_sha256=?2",
                rusqlite::params![json, sha],
            )
            .unwrap();
        let decoded = store.psx_materialized_inputs(&operation).unwrap();
        assert!(
            store
                .seal_psx_materialized_inputs(&journal, decoded, &operation)
                .is_err()
        );
        assert!(store.psx_normalized_inputs(&operation).is_err());
    }

    #[test]
    #[cfg(feature = "qualification-fixtures")]
    fn materialized_inputs_cancellation_preserves_unsealed_custody() {
        let temporary = tempfile::tempdir().unwrap();
        let (library, operation, journal, witness, _) = normalized_input_fixture(temporary.path());
        let store = crate::operation::OperationStore::new(library.clone());
        store
            .commit_psx_materialized_inputs(&journal, &witness, &operation)
            .unwrap();
        let service = crate::PortcoveService::new(library.clone()).unwrap();
        let (activity, control) = service
            .begin_cancellable_activity(
                crate::ActivityOperation::Install,
                crate::ActivityTargetKind::Port,
                Some("yu-gi-oh-forbidden-memories-recompiled"),
            )
            .unwrap();
        let child = control.retained_child(operation.operation_id(), "seal-cancel-control");
        let decoded = store.psx_materialized_inputs(&child).unwrap();
        service.request_cancellation(&activity.id).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(55));
        assert!(
            store
                .seal_psx_materialized_inputs(&journal, decoded, &child)
                .is_err()
        );
        assert!(store.psx_normalized_inputs(&operation).is_err());
        assert!(store.psx_materialized_inputs(&operation).is_ok());
    }

    #[test]
    #[cfg(feature = "qualification-fixtures")]
    fn normalization_decode_cancellation_refuses_before_helper_dispatch() {
        let temporary = tempfile::tempdir().unwrap();
        let (library, operation, journal, _, preparation) =
            normalized_input_fixture(temporary.path());
        let service = crate::PortcoveService::new(library.clone()).unwrap();
        let (activity, control) = service
            .begin_cancellable_activity(
                crate::ActivityOperation::Install,
                crate::ActivityTargetKind::Port,
                Some("yu-gi-oh-forbidden-memories-recompiled"),
            )
            .unwrap();
        let child =
            control.retained_child(operation.operation_id(), "normalization-cancel-control");
        let store = crate::operation::OperationStore::new(library.clone());
        let decoded = store.psx_bootstrap_for_normalization(&child).unwrap();
        let mut worker = journal.clone();
        worker.preparation_process_quiesced = Some(false);
        store.put(&mut worker).unwrap();
        service.request_cancellation(&activity.id).unwrap();
        // Let the existing bounded cancellation cache expire, without changing
        // its production interval or dispatching any executable fixture.
        std::thread::sleep(std::time::Duration::from_millis(55));
        let staging = journal.paths.staging.as_ref().unwrap();
        let before = fs::read_dir(staging).unwrap().count();
        let (result, quiesced) = NormalizedInputWitness::prepare(
            decoded,
            &library,
            &journal,
            &worker,
            &preparation,
            &child,
        );
        assert!(quiesced);
        assert_eq!(result.err().unwrap().code, crate::ErrorCode::Cancelled);
        assert_eq!(fs::read_dir(staging).unwrap().count(), before);
        assert!(store.psx_normalized_inputs(&operation).is_err());
    }

    #[test]
    fn normalization_decode_does_not_grant_content_acceptance() {
        for changed in ["archive", "payload"] {
            let temporary = tempfile::tempdir().unwrap();
            let (library, operation, journal, _, preparation) =
                normalized_input_fixture(temporary.path());
            let store = crate::operation::OperationStore::new(library.clone());
            let decoded = store.psx_bootstrap_for_normalization(&operation).unwrap();
            let path = journal
                .paths
                .staging
                .as_ref()
                .unwrap()
                .join(if changed == "archive" {
                    "artifact.download"
                } else {
                    "payload/generated.c"
                });
            let original = fs::read(&path).unwrap();
            let timestamp = fs::metadata(&path).unwrap().modified().unwrap();
            let mut different = original.clone();
            different[0] ^= 1;
            fs::write(&path, different).unwrap();
            fs::File::options()
                .write(true)
                .open(&path)
                .unwrap()
                .set_times(fs::FileTimes::new().set_modified(timestamp))
                .unwrap();
            assert_eq!(fs::metadata(&path).unwrap().len(), original.len() as u64);
            assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), timestamp);
            // Bounded decoding is deliberately not executable or content evidence.
            let mut worker = journal.clone();
            worker.preparation_process_quiesced = Some(false);
            store.put(&mut worker).unwrap();
            let staging = journal.paths.staging.as_ref().unwrap();
            let before = fs::read_dir(staging).unwrap().count();
            let (result, quiesced) = NormalizedInputWitness::prepare(
                decoded,
                &library,
                &journal,
                &worker,
                &preparation,
                &operation,
            );
            assert!(quiesced, "no helper was dispatched: {changed}");
            assert_eq!(
                result.err().unwrap().code,
                crate::ErrorCode::Verification,
                "{changed}"
            );
            assert_eq!(fs::read_dir(staging).unwrap().count(), before);
            #[cfg(feature = "qualification-fixtures")]
            {
                let diagnostics =
                    qualification_psx_preparation_diagnostics(operation.operation_id());
                let preparation = diagnostics["records"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|record| record["scope"] == "normalized_inputs")
                    .unwrap();
                assert_eq!(preparation["phase"], "bootstrap_verification");
                assert_eq!(preparation["completed"], false);
            }
            assert!(
                store.psx_bootstrap(&operation).is_err(),
                "ordinary loader remains fresh"
            );
            assert!(store.psx_normalized_inputs(&operation).is_err());
        }
    }

    #[test]
    fn normalization_decode_binds_only_the_exact_owned_worker_transition() {
        for drift in ["none", "parent", "journal", "operation", "library"] {
            let temporary = tempfile::tempdir().unwrap();
            let (library, operation, journal, _, _) = normalized_input_fixture(temporary.path());
            let store = crate::operation::OperationStore::new(library.clone());
            let decoded = store.psx_bootstrap_for_normalization(&operation).unwrap();
            let mut worker = journal.clone();
            worker.preparation_process_quiesced = Some(false);
            store.put(&mut worker).unwrap();
            let other_operation = OperationCoordinator::new("wrong-normalization-owner", None);
            let selected = if drift == "operation" {
                &other_operation
            } else {
                &operation
            };
            match drift {
                "parent" => {
                    library.connection().unwrap().execute(
                    "UPDATE managed_psx_bootstrap SET witness_sha256=?1 WHERE operation_id=?2",
                    rusqlite::params!["f".repeat(64), operation.operation_id()],
                ).unwrap();
                }
                "journal" => {
                    let mut changed = worker.clone();
                    changed.last_error = Some("retained failure".into());
                    store.put(&mut changed).unwrap();
                }
                "library" => {
                    library
                        .connection()
                        .unwrap()
                        .execute(
                            "UPDATE library_identity SET id='ffffffffffffffffffffffffffffffff'",
                            [],
                        )
                        .unwrap();
                }
                _ => {}
            }
            let result = decoded.require_owned_worker(&library, &journal, &worker, selected);
            assert_eq!(result.is_ok(), drift == "none", "{drift}");
            assert!(store.psx_normalized_inputs(&operation).is_err());
        }
    }

    #[test]
    fn normalization_decode_retains_failed_journal_refusal() {
        let temporary = tempfile::tempdir().unwrap();
        let (library, operation, mut journal, _, _) = normalized_input_fixture(temporary.path());
        let store = crate::operation::OperationStore::new(library);
        journal.last_error = Some("retained cancellation".into());
        store.put(&mut journal).unwrap();
        assert!(store.psx_bootstrap_for_normalization(&operation).is_err());
        assert_eq!(
            store
                .get(operation.operation_id())
                .unwrap()
                .unwrap()
                .last_error
                .as_deref(),
            Some("retained cancellation")
        );
    }

    #[test]
    fn generated_retail_bios_requires_exact_bound_source_bytes() {
        let temporary = tempfile::tempdir().unwrap();
        let operation = OperationCoordinator::new("generated-retail-bios-fixture", None);
        let bios = bios_fixture(&temporary.path().join("original-retail-bios"));
        let destination = temporary.path().join("staged-retail-bios");
        fs::copy(&bios.path, &destination).unwrap();
        normalized_inputs::verify_generated_bios(&destination, &bios, &operation).unwrap();
        let timestamp = fs::metadata(&destination).unwrap().modified().unwrap();
        let mut bytes = fs::read(&destination).unwrap();
        bytes[0] ^= 1;
        fs::write(&destination, bytes).unwrap();
        fs::File::options()
            .write(true)
            .open(&destination)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(timestamp))
            .unwrap();
        assert!(normalized_inputs::verify_generated_bios(&destination, &bios, &operation).is_err());
    }

    #[test]
    fn generation_recipe_refuses_serialized_argument_bios_and_input_drift() {
        for drift in ["none", "arguments", "bios", "inputs", "disc"] {
            let temporary = tempfile::tempdir().unwrap();
            let (_, operation, _, normalized, preparation) =
                normalized_input_fixture(temporary.path());
            let json = serde_json::to_value(&normalized).unwrap();
            let root: PathBuf =
                serde_json::from_value(json["bootstrap"]["payload"]["root"].clone()).unwrap();
            let cue: PathBuf = serde_json::from_value(json["cue"].clone()).unwrap();
            let mut generated = GeneratedInstall {
                tree: stage::GeneratedTree::capture(&root, &operation, true).unwrap(),
                toolchain: stage::GeneratedTree::capture(
                    &preparation.toolchain_root,
                    &operation,
                    true,
                )
                .unwrap(),
                normalized_disc: serde_json::from_value(json["disc"].clone()).unwrap(),
                inputs: preparation_identity(&preparation).unwrap(),
                generation_arguments: generation_arguments(
                    &root.join("game.toml"),
                    &root,
                    &cue,
                    None,
                )
                .unwrap(),
                staged_bios: None,
            };
            match drift {
                "arguments" => generated.generation_arguments.push("--force-bios".into()),
                "bios" => generated.staged_bios = Some(root.join("unbound-retail-bios")),
                "inputs" => generated.inputs.push(b' '),
                "disc" => {
                    generated.normalized_disc =
                        stage::GeneratedTree::capture(&root, &operation, true).unwrap()
                }
                _ => {}
            }
            // Model a store-loaded child with a freshly recomputed child hash:
            // recipe authority must still come from the bound predecessor.
            let decoded: GeneratedInstall =
                serde_json::from_slice(&serde_json::to_vec(&generated).unwrap()).unwrap();
            assert_eq!(
                normalized
                    .require_generation_recipe(&decoded, &preparation)
                    .is_ok(),
                drift == "none",
                "{drift}"
            );
        }
    }

    #[test]
    fn generation_input_decode_binds_normalized_bytes_and_exact_worker_transition() {
        for drift in [
            "none",
            "normalized",
            "parent",
            "journal",
            "operation",
            "library",
        ] {
            let temporary = tempfile::tempdir().unwrap();
            let (library, operation, journal, witness, preparation) =
                normalized_input_fixture(temporary.path());
            let store = crate::operation::OperationStore::new(library.clone());
            store
                .commit_psx_normalized_inputs(&journal, &witness, &operation)
                .unwrap();
            let decoded = store.psx_inputs_for_generation(&operation).unwrap();
            let contract = serde_json::to_value(&witness).unwrap()["bootstrap"]["contract"].clone();
            decoded.require_request(&contract, &preparation).unwrap();
            assert_eq!(decoded.artifact(), witness.artifact());
            let mut worker = journal.clone();
            worker.preparation_process_quiesced = Some(false);
            store.put(&mut worker).unwrap();
            let other = OperationCoordinator::new("wrong-generation-owner", None);
            match drift {
                "normalized" | "parent" => {
                    let table = if drift == "normalized" {
                        "managed_psx_normalized_inputs"
                    } else {
                        "managed_psx_bootstrap"
                    };
                    library
                        .connection()
                        .unwrap()
                        .execute(
                            &format!("UPDATE {table} SET witness_sha256=?1 WHERE operation_id=?2"),
                            rusqlite::params!["f".repeat(64), operation.operation_id()],
                        )
                        .unwrap();
                }
                "journal" => {
                    let mut changed = worker.clone();
                    changed.last_error = Some("preserved failed evidence".into());
                    store.put(&mut changed).unwrap();
                }
                "library" => {
                    library
                        .connection()
                        .unwrap()
                        .execute(
                            "UPDATE library_identity SET id='ffffffffffffffffffffffffffffffff'",
                            [],
                        )
                        .unwrap();
                }
                _ => {}
            }
            let selected = if drift == "operation" {
                &other
            } else {
                &operation
            };
            assert_eq!(
                decoded
                    .require_owned_worker(&library, &journal, &worker, selected)
                    .is_ok(),
                drift == "none",
                "{drift}"
            );
            assert!(store.psx_generation(&operation).is_err());
        }
    }

    #[test]
    fn generation_continuation_preserves_failed_journal_and_seals_strictly() {
        let temporary = tempfile::tempdir().unwrap();
        let (library, operation, mut prior, _, preparation) =
            normalized_generation_fixture(temporary.path());
        let store = crate::operation::OperationStore::new(library.clone());
        prior.last_error = Some("Operation cancelled before publication".into());
        store.put(&mut prior).unwrap();
        assert!(store.psx_normalized_inputs(&operation).is_err());
        assert!(store.psx_bootstrap(&operation).is_err());
        #[cfg(feature = "qualification-fixtures")]
        {
            let expected = store
                .psx_inputs_for_generation(&operation)
                .unwrap()
                .witness()
                .acquired_contract()
                .clone();
            assert_eq!(
                store
                    .psx_historical_qualification_contract(&operation, true)
                    .unwrap(),
                expected
            );
            assert!(
                store
                    .psx_historical_qualification_contract(&operation, false)
                    .is_err()
            );
            assert_eq!(
                store
                    .get(operation.operation_id())
                    .unwrap()
                    .unwrap()
                    .last_error,
                prior.last_error
            );
        }
        let mut decoded = store.psx_inputs_for_generation(&operation).unwrap();
        let worker = store
            .start_psx_generation(&mut decoded, &prior, &operation)
            .unwrap();
        assert!(worker.last_error.is_none());
        assert_eq!(worker.preparation_process_quiesced, Some(false));
        assert!(store.psx_inputs_for_generation(&operation).is_err());
        let decoded = decoded
            .verify_for_generation(&library, &prior, &worker, &operation)
            .unwrap();
        let history = decoded.attempt_history();
        let receipt: String = library.connection().unwrap().query_row(
            "SELECT receipt_json FROM managed_psx_generation_attempts WHERE operation_id=?1 AND attempt=1",
            [operation.operation_id()], |row| row.get(0),
        ).unwrap();
        let receipt: serde_json::Value = serde_json::from_str(&receipt).unwrap();
        assert_eq!(
            receipt["prior_journal"][12],
            prior.last_error.as_deref().unwrap()
        );
        assert_eq!(receipt["prior_journal"][16], 1);
        assert_eq!(receipt["prior_journal"].as_array().unwrap().len(), 17);
        let mut candidate = decoded
            .into_witness()
            .inert_generated_fixture(&preparation, &operation)
            .unwrap();
        candidate.retain_attempt_history(history.clone());
        let mut completed = worker.clone();
        completed.preparation_process_quiesced = Some(true);
        store
            .put_psx_generation_outcome(&worker, &mut completed, &history, &operation)
            .unwrap();
        store
            .commit_psx_pending_generation(&completed, &candidate, &operation)
            .unwrap();
        let pending = store.psx_pending_generation(&operation).unwrap();
        store
            .seal_psx_generation(&completed, pending, &operation)
            .unwrap();
        let generation = store.psx_generation(&operation).unwrap();
        assert_eq!(generation.generation_attempt_history(), Some(&history));
        assert!(store.psx_inputs_for_generation(&operation).is_err());
        assert!(library.all_installs().unwrap().is_empty());
        assert!(!completed.paths.final_path.as_ref().unwrap().exists());
        assert_eq!(
            library
                .connection()
                .unwrap()
                .query_row(
                    "SELECT count(*) FROM managed_psx_generation_attempts",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
    }

    #[test]
    fn generation_continuation_acknowledgement_never_replaces_content_verification() {
        for drift in ["archive", "payload", "disc", "helper", "source"] {
            let temporary = tempfile::tempdir().unwrap();
            let (library, operation, mut prior, witness, preparation) =
                normalized_input_fixture(temporary.path());
            let store = crate::operation::OperationStore::new(library.clone());
            store
                .commit_psx_normalized_inputs(&prior, &witness, &operation)
                .unwrap();
            prior.last_error = Some("retained prior failure".into());
            store.put(&mut prior).unwrap();
            let mut decoded = store.psx_inputs_for_generation(&operation).unwrap();
            let worker = store
                .start_psx_generation(&mut decoded, &prior, &operation)
                .unwrap();
            let history = decoded.attempt_history();
            let staging = prior.paths.staging.as_ref().unwrap();
            let path = match drift {
                "archive" => Some(staging.join("artifact.download")),
                "payload" => Some(staging.join("payload/generated.c")),
                "disc" => Some(staging.join("psx-source-inert/disc.cue")),
                "helper" => Some(temporary.path().join("inert-chd-helper")),
                "source" => Some(preparation.source.path.clone()),
                _ => None,
            };
            if let Some(path) = path {
                let timestamp = fs::metadata(&path).unwrap().modified().unwrap();
                let mut bytes = fs::read(&path).unwrap();
                bytes[0] ^= 1;
                fs::write(&path, bytes).unwrap();
                fs::File::options()
                    .write(true)
                    .open(&path)
                    .unwrap()
                    .set_times(fs::FileTimes::new().set_modified(timestamp))
                    .unwrap();
            }
            let error = match decoded.verify_for_generation(&library, &prior, &worker, &operation) {
                Err(error) => error,
                Ok(_) => panic!("fresh verification accepted {drift}"),
            };
            let mut completed = worker.clone();
            completed.preparation_process_quiesced = Some(true);
            completed.last_error = Some(error.message);
            store
                .put_psx_generation_outcome(&worker, &mut completed, &history, &operation)
                .unwrap();
            assert!(store.psx_generation(&operation).is_err());
            assert!(store.psx_pending_generation(&operation).is_err());
            assert!(library.all_installs().unwrap().is_empty());
            let receipt: String = library
                .connection()
                .unwrap()
                .query_row(
                    "SELECT receipt_json FROM managed_psx_generation_attempts",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&receipt).unwrap()["prior_journal"][12],
                "retained prior failure"
            );
            assert_eq!(
                store
                    .get(operation.operation_id())
                    .unwrap()
                    .unwrap()
                    .preparation_process_quiesced,
                Some(true)
            );
        }
    }

    #[test]
    #[cfg(feature = "qualification-fixtures")]
    fn generation_continuation_cancelled_before_dispatch_retains_both_failures() {
        let temporary = tempfile::tempdir().unwrap();
        let (library, operation, mut prior, witness, _) =
            normalized_input_fixture(temporary.path());
        let store = crate::operation::OperationStore::new(library.clone());
        store
            .commit_psx_normalized_inputs(&prior, &witness, &operation)
            .unwrap();
        prior.last_error = Some("historical failed attempt".into());
        store.put(&mut prior).unwrap();
        let mut decoded = store.psx_inputs_for_generation(&operation).unwrap();
        let worker = store
            .start_psx_generation(&mut decoded, &prior, &operation)
            .unwrap();
        let history = decoded.attempt_history();
        let service = crate::PortcoveService::new(library.clone()).unwrap();
        let (activity, control) = service
            .begin_cancellable_activity(
                crate::ActivityOperation::Install,
                crate::ActivityTargetKind::Port,
                Some(&prior.port_id),
            )
            .unwrap();
        let cancellation =
            control.retained_child(operation.operation_id(), "cancel-generation-continuation");
        service.request_cancellation(&activity.id).unwrap();
        let error = match decoded.verify_for_generation(&library, &prior, &worker, &cancellation) {
            Err(error) => error,
            Ok(_) => panic!("cancelled predecessor was admitted"),
        };
        assert_eq!(error.code, crate::ErrorCode::Cancelled);
        let mut completed = worker.clone();
        completed.preparation_process_quiesced = Some(true);
        completed.last_error = Some(error.message);
        store
            .put_psx_generation_outcome(&worker, &mut completed, &history, &cancellation)
            .unwrap();
        assert!(
            store
                .get(operation.operation_id())
                .unwrap()
                .unwrap()
                .last_error
                .is_some()
        );
        history.require_current(&library, &operation).unwrap();
        assert!(store.psx_pending_generation(&operation).is_err());
        assert!(library.all_installs().unwrap().is_empty());
    }

    #[test]
    fn generation_continuation_start_refuses_whole_journal_parent_and_replay_drift() {
        assert_generation_start_refuses_drift(&[
            "error", "port", "staging", "final", "created", "updated",
        ]);
    }

    #[test]
    fn generation_continuation_start_refuses_closure_and_parent_drift() {
        assert_generation_start_refuses_drift(&[
            "activate",
            "closed",
            "phase",
            "original",
            "normalized",
            "parent",
        ]);
    }

    #[test]
    fn generation_continuation_start_refuses_advanced_or_installed_custody() {
        assert_generation_start_refuses_drift(&[
            "library",
            "pending",
            "advanced",
            "compile-history",
            "install",
        ]);
    }

    fn assert_generation_start_refuses_drift(drifts: &[&str]) {
        for &drift in drifts {
            let temporary = tempfile::tempdir().unwrap();
            let (library, operation, mut prior, witness, _) =
                normalized_input_fixture(temporary.path());
            let store = crate::operation::OperationStore::new(library.clone());
            store
                .commit_psx_normalized_inputs(&prior, &witness, &operation)
                .unwrap();
            prior.last_error = Some("unchanged historical failure".into());
            store.put(&mut prior).unwrap();
            let mut decoded = store.psx_inputs_for_generation(&operation).unwrap();
            let connection = library.connection().unwrap();
            match drift {
                "error" => {
                    connection
                        .execute(
                            "UPDATE lifecycle_operations SET last_error='different failure'",
                            [],
                        )
                        .unwrap();
                }
                "port" => {
                    connection
                        .execute(
                            "UPDATE lifecycle_operations SET port_id='different-port'",
                            [],
                        )
                        .unwrap();
                }
                "staging" => {
                    connection
                        .execute(
                            "UPDATE lifecycle_operations SET staging_path='different-stage'",
                            [],
                        )
                        .unwrap();
                }
                "final" => {
                    connection
                        .execute(
                            "UPDATE lifecycle_operations SET final_path='different-final'",
                            [],
                        )
                        .unwrap();
                }
                "created" => {
                    connection
                        .execute(
                            "UPDATE lifecycle_operations SET created_at=created_at+1",
                            [],
                        )
                        .unwrap();
                }
                "updated" => {
                    connection
                        .execute(
                            "UPDATE lifecycle_operations SET updated_at=updated_at+1",
                            [],
                        )
                        .unwrap();
                }
                "activate" => {
                    connection
                        .execute("UPDATE lifecycle_operations SET activate=1-activate", [])
                        .unwrap();
                }
                "closed" => {
                    connection
                        .execute(
                            "UPDATE lifecycle_operations SET preparation_process_quiesced=0",
                            [],
                        )
                        .unwrap();
                }
                "phase" => {
                    connection
                        .execute("UPDATE lifecycle_operations SET phase='prepared'", [])
                        .unwrap();
                }
                "original" => {
                    connection
                        .execute(
                            "UPDATE lifecycle_operations SET original_paths_json='[\"unowned\"]'",
                            [],
                        )
                        .unwrap();
                }
                "normalized" | "parent" => {
                    let table = if drift == "normalized" {
                        "managed_psx_normalized_inputs"
                    } else {
                        "managed_psx_bootstrap"
                    };
                    connection
                        .execute(
                            &format!("UPDATE {table} SET witness_sha256=?1"),
                            ["f".repeat(64)],
                        )
                        .unwrap();
                }
                "library" => {
                    connection
                        .execute(
                            "UPDATE library_identity SET id='ffffffffffffffffffffffffffffffff'",
                            [],
                        )
                        .unwrap();
                }
                "pending" | "advanced" => {
                    let table = if drift == "pending" {
                        "managed_psx_pending_generation"
                    } else {
                        "managed_psx_generation"
                    };
                    connection.execute(&format!("INSERT INTO {table}(operation_id,witness_json,witness_sha256) VALUES (?1,'{{}}',?2)"),
                        rusqlite::params![operation.operation_id(), "f".repeat(64)]).unwrap();
                }
                "compile-history" => {
                    for table in [
                        "managed_psx_generation",
                        "managed_psx_configuration",
                        "managed_psx_compilation",
                    ] {
                        connection.execute(&format!("INSERT INTO {table}(operation_id,witness_json,witness_sha256) VALUES (?1,'{{}}',?2)"), rusqlite::params![operation.operation_id(), "f".repeat(64)]).unwrap();
                    }
                    connection.execute("INSERT INTO managed_psx_compile_history(operation_id,completed_batches,witness_json,witness_sha256) VALUES (?1,1,'{}',?2)", rusqlite::params![operation.operation_id(), "f".repeat(64)]).unwrap();
                }
                "install" => {
                    connection.execute("INSERT INTO installs(id,port_id,version,path,channel,installed_at,verified) VALUES ('another',?1,'inert','unowned','inert',0,0)", [&prior.port_id]).unwrap();
                }
                _ => unreachable!(),
            }
            assert!(
                store
                    .start_psx_generation(&mut decoded, &prior, &operation)
                    .is_err(),
                "{drift}"
            );
            assert_eq!(
                connection
                    .query_row(
                        "SELECT count(*) FROM managed_psx_generation_attempts",
                        [],
                        |row| row.get::<_, i64>(0)
                    )
                    .unwrap(),
                0,
                "{drift}"
            );
        }
    }

    #[test]
    fn generation_continuation_start_rolls_back_retention_when_acknowledgement_fails() {
        let temporary = tempfile::tempdir().unwrap();
        let (library, operation, mut prior, witness, _) =
            normalized_input_fixture(temporary.path());
        let store = crate::operation::OperationStore::new(library.clone());
        store
            .commit_psx_normalized_inputs(&prior, &witness, &operation)
            .unwrap();
        prior.last_error = Some("must survive rollback".into());
        store.put(&mut prior).unwrap();
        let mut decoded = store.psx_inputs_for_generation(&operation).unwrap();
        library
            .connection()
            .unwrap()
            .execute_batch(
                "CREATE TRIGGER refuse_generation_ack BEFORE UPDATE ON lifecycle_operations
             WHEN NEW.last_error IS NULL BEGIN SELECT RAISE(ABORT,'inert refusal'); END;",
            )
            .unwrap();
        assert!(
            store
                .start_psx_generation(&mut decoded, &prior, &operation)
                .is_err()
        );
        assert_eq!(
            store
                .get(operation.operation_id())
                .unwrap()
                .unwrap()
                .last_error,
            prior.last_error
        );
        assert_eq!(
            library
                .connection()
                .unwrap()
                .query_row(
                    "SELECT count(*) FROM managed_psx_generation_attempts",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
    }

    #[test]
    fn generation_continuation_history_drift_refuses_dispatch_completion_and_pending_commit() {
        for drift in ["delete", "rewrite", "reorder"] {
            let temporary = tempfile::tempdir().unwrap();
            let (library, operation, mut prior, _, preparation) =
                normalized_generation_fixture(temporary.path());
            let store = crate::operation::OperationStore::new(library.clone());
            prior.last_error = Some("retained before history drift".into());
            store.put(&mut prior).unwrap();
            let mut decoded = store.psx_inputs_for_generation(&operation).unwrap();
            let worker = store
                .start_psx_generation(&mut decoded, &prior, &operation)
                .unwrap();
            let history = decoded.attempt_history();
            decoded
                .require_owned_worker(&library, &prior, &worker, &operation)
                .unwrap();
            let connection = library.connection().unwrap();
            match drift {
                "delete" => {
                    connection
                        .execute("DELETE FROM managed_psx_generation_attempts", [])
                        .unwrap();
                }
                "rewrite" => {
                    connection
                        .execute(
                            "UPDATE managed_psx_generation_attempts SET receipt_json='{}'",
                            [],
                        )
                        .unwrap();
                }
                "reorder" => {
                    connection
                        .execute("UPDATE managed_psx_generation_attempts SET attempt=2", [])
                        .unwrap();
                }
                _ => unreachable!(),
            }
            assert!(
                decoded
                    .require_owned_worker(&library, &prior, &worker, &operation)
                    .is_err()
            );
            let mut completed = worker.clone();
            completed.preparation_process_quiesced = Some(true);
            assert!(
                store
                    .put_psx_generation_outcome(&worker, &mut completed, &history, &operation)
                    .is_err()
            );
            assert_eq!(
                store
                    .get(operation.operation_id())
                    .unwrap()
                    .unwrap()
                    .preparation_process_quiesced,
                Some(false)
            );
            // An inert output fixture cannot bypass the missing historical binding.
            let mut candidate = decoded
                .into_witness()
                .inert_generated_fixture(&preparation, &operation)
                .unwrap();
            candidate.retain_attempt_history(history);
            store.put(&mut completed).unwrap();
            assert!(
                store
                    .commit_psx_pending_generation(&completed, &candidate, &operation)
                    .is_err()
            );
        }
    }

    #[test]
    fn generation_continuation_attempt_count_byte_and_row_caps_preserve_current_failure() {
        for size in [16usize, 60_000, 65_536] {
            let temporary = tempfile::tempdir().unwrap();
            let (library, operation, mut prior, witness, _) =
                normalized_input_fixture(temporary.path());
            let store = crate::operation::OperationStore::new(library.clone());
            store
                .commit_psx_normalized_inputs(&prior, &witness, &operation)
                .unwrap();
            prior.last_error = Some("real initial fixture failure".into());
            store.put(&mut prior).unwrap();
            let mut decoded = store.psx_inputs_for_generation(&operation).unwrap();
            let worker = store
                .start_psx_generation(&mut decoded, &prior, &operation)
                .unwrap();
            let mut completed = worker.clone();
            completed.preparation_process_quiesced = Some(true);
            store
                .put_psx_generation_outcome(
                    &worker,
                    &mut completed,
                    &decoded.attempt_history(),
                    &operation,
                )
                .unwrap();
            prior = completed;
            let mut connection = library.connection().unwrap();
            let receipt: String = connection
                .query_row(
                    "SELECT receipt_json FROM managed_psx_generation_attempts",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            let mut receipt: serde_json::Value = serde_json::from_str(&receipt).unwrap();
            // Seed a valid bounded history fixture at the boundary directly;
            // repeated start/stop cycles are not needed to test one refusal.
            receipt["prior_journal"][12] = serde_json::json!("e".repeat(size.min(60_000)));
            let receipt = serde_json::to_string(&receipt).unwrap();
            let count = if size == 65_536 {
                1
            } else {
                (1024 * 1024 / receipt.len()).min(32)
            };
            let transaction = connection.transaction().unwrap();
            transaction
                .execute(
                    "UPDATE managed_psx_generation_attempts SET receipt_json=?1,receipt_sha256=?2",
                    rusqlite::params![
                        receipt,
                        hex::encode(sha2::Sha256::digest(receipt.as_bytes()))
                    ],
                )
                .unwrap();
            let mut digest = sha2::Sha256::new();
            for attempt in 1..=count {
                if attempt != 1 {
                    transaction.execute("INSERT INTO managed_psx_generation_attempts(operation_id,attempt,receipt_json,receipt_sha256) VALUES (?1,?2,?3,?4)", rusqlite::params![operation.operation_id(), attempt as i64, receipt, hex::encode(sha2::Sha256::digest(receipt.as_bytes()))]).unwrap();
                }
                digest.update((attempt as i64).to_le_bytes());
                digest.update((receipt.len() as u64).to_le_bytes());
                digest.update(receipt.as_bytes());
            }
            transaction
                .execute(
                    "UPDATE managed_psx_normalized_inputs SET generation_attempt_history_sha256=?1",
                    [hex::encode(digest.finalize())],
                )
                .unwrap();
            transaction.commit().unwrap();
            prior.last_error = Some("e".repeat(size));
            store.put(&mut prior).unwrap();
            let mut decoded = store.psx_inputs_for_generation(&operation).unwrap();
            assert!(
                store
                    .start_psx_generation(&mut decoded, &prior, &operation)
                    .is_err(),
                "{size}"
            );
            let retained = store.get(operation.operation_id()).unwrap().unwrap();
            assert_eq!(retained.last_error, prior.last_error);
            assert_eq!(retained.preparation_process_quiesced, Some(true));
            let (count, bytes): (i64, i64) = library.connection().unwrap().query_row(
                "SELECT count(*),coalesce(sum(length(CAST(receipt_json AS BLOB))),0) FROM managed_psx_generation_attempts", [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            ).unwrap();
            assert_eq!(
                count as usize,
                if size == 65_536 {
                    1
                } else {
                    (1024 * 1024 / receipt.len()).min(32)
                }
            );
            assert!(bytes <= 1024 * 1024);
        }
    }

    #[test]
    fn generation_continuation_fresh_load_refuses_deleted_rewritten_or_truncated_history() {
        for drift in ["delete", "rewrite", "truncate"] {
            let temporary = tempfile::tempdir().unwrap();
            let (library, operation, mut prior, witness, _) =
                normalized_input_fixture(temporary.path());
            let store = crate::operation::OperationStore::new(library.clone());
            store
                .commit_psx_normalized_inputs(&prior, &witness, &operation)
                .unwrap();
            for error in ["first preserved failure", "second preserved failure"] {
                prior.last_error = Some(error.into());
                store.put(&mut prior).unwrap();
                let mut decoded = store.psx_inputs_for_generation(&operation).unwrap();
                let worker = store
                    .start_psx_generation(&mut decoded, &prior, &operation)
                    .unwrap();
                let mut completed = worker.clone();
                completed.preparation_process_quiesced = Some(true);
                completed.last_error = Some("current closed failed attempt".into());
                store
                    .put_psx_generation_outcome(
                        &worker,
                        &mut completed,
                        &decoded.attempt_history(),
                        &operation,
                    )
                    .unwrap();
                prior = completed;
            }
            let reopened =
                crate::operation::OperationStore::new(Library::open(library.root()).unwrap());
            assert!(reopened.psx_inputs_for_generation(&operation).is_ok());
            let connection = library.connection().unwrap();
            let anchor: String = connection
                .query_row(
                    "SELECT generation_attempt_history_sha256 FROM managed_psx_normalized_inputs",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            match drift {
                "delete" => {
                    connection
                        .execute("DELETE FROM managed_psx_generation_attempts", [])
                        .unwrap();
                }
                "truncate" => {
                    connection
                        .execute(
                            "DELETE FROM managed_psx_generation_attempts WHERE attempt=2",
                            [],
                        )
                        .unwrap();
                }
                "rewrite" => {
                    let receipt: String = connection.query_row("SELECT receipt_json FROM managed_psx_generation_attempts WHERE attempt=1", [], |row| row.get(0)).unwrap();
                    let mut receipt: serde_json::Value = serde_json::from_str(&receipt).unwrap();
                    receipt["prior_journal"][12] =
                        serde_json::json!("validly rehashed replacement error");
                    let json = serde_json::to_string(&receipt).unwrap();
                    connection.execute("UPDATE managed_psx_generation_attempts SET receipt_json=?1,receipt_sha256=?2 WHERE attempt=1", rusqlite::params![json, hex::encode(sha2::Sha256::digest(json.as_bytes()))]).unwrap();
                }
                _ => unreachable!(),
            }
            assert!(
                reopened.psx_inputs_for_generation(&operation).is_err(),
                "{drift}"
            );
            assert_eq!(
                store
                    .get(operation.operation_id())
                    .unwrap()
                    .unwrap()
                    .last_error,
                prior.last_error
            );
            assert_eq!(connection.query_row("SELECT generation_attempt_history_sha256 FROM managed_psx_normalized_inputs", [], |row| row.get::<_, String>(0)).unwrap(), anchor);
            assert!(store.psx_pending_generation(&operation).is_err());
            assert!(library.all_installs().unwrap().is_empty());
        }
    }

    #[test]
    fn generation_input_decode_requires_fresh_content_without_helper_replay() {
        for drift in ["none", "archive", "payload", "disc", "helper", "source"] {
            let temporary = tempfile::tempdir().unwrap();
            let (library, operation, journal, witness, preparation) =
                normalized_input_fixture(temporary.path());
            let store = crate::operation::OperationStore::new(library.clone());
            store
                .commit_psx_normalized_inputs(&journal, &witness, &operation)
                .unwrap();
            let decoded = store.psx_inputs_for_generation(&operation).unwrap();
            let staging = journal.paths.staging.as_ref().unwrap();
            let path = match drift {
                "archive" => Some(staging.join("artifact.download")),
                "payload" => Some(staging.join("payload/generated.c")),
                "disc" => Some(staging.join("psx-source-inert/disc.cue")),
                "helper" => Some(temporary.path().join("inert-chd-helper")),
                "source" => Some(preparation.source.path.clone()),
                _ => None,
            };
            if let Some(path) = path {
                let timestamp = fs::metadata(&path).unwrap().modified().unwrap();
                let mut bytes = fs::read(&path).unwrap();
                bytes[0] ^= 1;
                fs::write(&path, bytes).unwrap();
                fs::File::options()
                    .write(true)
                    .open(&path)
                    .unwrap()
                    .set_times(fs::FileTimes::new().set_modified(timestamp))
                    .unwrap();
            }
            let mut worker = journal.clone();
            worker.preparation_process_quiesced = Some(false);
            store.put(&mut worker).unwrap();
            let before = fs::read_dir(staging).unwrap().count();
            let result = decoded.verify_for_generation(&library, &journal, &worker, &operation);
            assert_eq!(result.is_ok(), drift == "none", "{drift}");
            assert_eq!(fs::read_dir(staging).unwrap().count(), before);
            assert!(store.psx_generation(&operation).is_err());
            assert_eq!(
                store
                    .get(operation.operation_id())
                    .unwrap()
                    .unwrap()
                    .preparation_process_quiesced,
                Some(false)
            );
        }
    }

    #[test]
    fn normalized_inputs_reopen_without_generation_or_publication() {
        let temporary = tempfile::tempdir().unwrap();
        let (library, operation, journal, witness, _) = normalized_input_fixture(temporary.path());
        let store = crate::operation::OperationStore::new(library.clone());
        store
            .commit_psx_normalized_inputs(&journal, &witness, &operation)
            .unwrap();
        let reopened = crate::Installer::new(library.clone())
            .unwrap()
            .managed_install_normalized_inputs(operation.operation_id())
            .unwrap();
        assert_eq!(reopened.operation_id, operation.operation_id());
        assert_eq!(reopened.port_id, witness.port_id());
        assert!(store.psx_generation(&operation).is_err());
        assert!(store.psx_configuration(&operation).is_err());
        assert!(store.psx_compilation(&operation).is_err());
        let retained = store.get(operation.operation_id()).unwrap().unwrap();
        assert_eq!(
            retained.phase,
            crate::operation::LifecyclePhase::StagedPreparing
        );
        assert_eq!(retained.preparation_process_quiesced, Some(true));
        assert!(
            retained.install.is_none()
                && retained.preparation.is_none()
                && retained.last_error.is_none()
        );
    }

    #[test]
    fn normalized_inputs_refuse_disc_helper_source_and_archive_drift() {
        for changed in ["disc", "helper", "source", "archive"] {
            let temporary = tempfile::tempdir().unwrap();
            let (library, operation, journal, witness, preparation) =
                normalized_input_fixture(temporary.path());
            let store = crate::operation::OperationStore::new(library.clone());
            store
                .commit_psx_normalized_inputs(&journal, &witness, &operation)
                .unwrap();
            let path = match changed {
                "disc" => journal
                    .paths
                    .staging
                    .as_ref()
                    .unwrap()
                    .join("psx-source-inert/disc.bin"),
                "helper" => temporary.path().join("inert-chd-helper"),
                "source" => preparation.source.path,
                _ => journal
                    .paths
                    .staging
                    .as_ref()
                    .unwrap()
                    .join("artifact.download"),
            };
            fs::write(path, "changed after sealing").unwrap();
            assert!(
                store.psx_normalized_inputs(&operation).is_err(),
                "{changed}"
            );
            assert!(store.psx_generation(&operation).is_err());
        }
    }

    #[test]
    fn normalized_inputs_refuse_failed_or_unclosed_journal() {
        for failed in [false, true] {
            let temporary = tempfile::tempdir().unwrap();
            let (library, operation, mut journal, witness, _) =
                normalized_input_fixture(temporary.path());
            if failed {
                journal.last_error = Some("retained failure".into());
            } else {
                journal.preparation_process_quiesced = Some(false);
            }
            let store = crate::operation::OperationStore::new(library.clone());
            store.put(&mut journal).unwrap();
            assert!(
                store
                    .commit_psx_normalized_inputs(&journal, &witness, &operation)
                    .is_err()
            );
            assert!(store.psx_normalized_inputs(&operation).is_err());
        }
    }

    #[test]
    fn normalized_inputs_refuse_repeat_or_legacy_generation_before_dispatch() {
        let temporary = tempfile::tempdir().unwrap();
        let (library, operation, journal, witness, preparation) =
            normalized_input_fixture(temporary.path());
        let store = crate::operation::OperationStore::new(library.clone());
        store
            .commit_psx_normalized_inputs(&journal, &witness, &operation)
            .unwrap();
        assert!(store.require_psx_normalization_vacant(&operation).is_err());
        assert!(
            store
                .commit_psx_normalized_inputs(&journal, &witness, &operation)
                .is_err()
        );
        let loaded = store.psx_bootstrap(&operation).unwrap();
        let (result, quiesced) = loaded.generate(&library, &journal, &preparation, &operation);
        assert!(quiesced);
        assert!(
            result
                .err()
                .unwrap()
                .message
                .contains("normalized inputs already retained")
        );
        assert!(store.psx_generation(&operation).is_err());
    }

    #[test]
    fn normalized_inputs_atomic_fence_refuses_changed_acquired_predecessor() {
        let temporary = tempfile::tempdir().unwrap();
        let (library, operation, journal, witness, _) = normalized_input_fixture(temporary.path());
        let store = crate::operation::OperationStore::new(library.clone());
        store
            .commit_psx_normalized_inputs(&journal, &witness, &operation)
            .unwrap();
        let result = store.psx_normalized_inputs_before_fence(&operation, || {
            library.connection()?.execute(
                "UPDATE managed_psx_bootstrap SET witness_sha256=?1 WHERE operation_id=?2",
                rusqlite::params!["f".repeat(64), operation.operation_id()],
            )?;
            Ok(())
        });
        assert!(result.is_err());
        assert!(store.psx_generation(&operation).is_err());
    }

    #[test]
    fn normalized_inputs_refuse_coherently_changed_embedded_context_with_valid_child_hash() {
        use sha2::Digest;
        let temporary = tempfile::tempdir().unwrap();
        let (library, operation, journal, witness, mut preparation) =
            normalized_input_fixture(temporary.path());
        let store = crate::operation::OperationStore::new(library.clone());
        store
            .commit_psx_normalized_inputs(&journal, &witness, &operation)
            .unwrap();
        // Change both embedded contexts coherently, while retaining the valid
        // acquired binding and recomputing the child's ordinary integrity hash.
        // This must not invent a new source contract for the same predecessor.
        preparation.source.profile_id = "different-source-contract".into();
        let inputs = serde_json::to_value(preparation_identity(&preparation).unwrap()).unwrap();
        let mut changed = serde_json::to_value(&witness).unwrap();
        changed["inputs"] = inputs.clone();
        changed["bootstrap"]["inputs"] = inputs;
        let json = serde_json::to_string(&changed).unwrap();
        let sha = hex::encode(sha2::Sha256::digest(json.as_bytes()));
        library.connection().unwrap().execute(
            "UPDATE managed_psx_normalized_inputs SET witness_json=?1,witness_sha256=?2 WHERE operation_id=?3",
            rusqlite::params![json, sha, operation.operation_id()],
        ).unwrap();
        let error = store.psx_normalized_inputs(&operation).err().unwrap();
        assert!(error.message.contains("predecessor context changed"));
        assert!(store.psx_generation(&operation).is_err());
    }

    #[test]
    fn bootstrap_refuses_payload_replacement_and_unclosed_or_failed_journal() {
        use crate::operation::OperationStore;
        let temporary = tempfile::tempdir().unwrap();
        let (library, operation, mut journal, witness, _, _) = bootstrap_fixture(temporary.path());
        let store = OperationStore::new(library.clone());
        journal.preparation_process_quiesced = Some(false);
        store.put(&mut journal).unwrap();
        assert!(
            store
                .commit_psx_bootstrap(&journal, &witness, &operation)
                .is_err()
        );
        journal.preparation_process_quiesced = Some(true);
        store.put(&mut journal).unwrap();
        store
            .commit_psx_bootstrap(&journal, &witness, &operation)
            .unwrap();
        journal.last_error = Some("retained failure".into());
        store.put(&mut journal).unwrap();
        assert!(store.psx_bootstrap(&operation).is_err());
        journal.last_error = None;
        store.put(&mut journal).unwrap();
        let payload = journal
            .paths
            .staging
            .as_ref()
            .unwrap()
            .join("payload/generated.c");
        let bytes = fs::read(&payload).unwrap();
        fs::rename(&payload, payload.with_extension("retained")).unwrap();
        fs::write(&payload, bytes).unwrap();
        assert!(store.psx_bootstrap(&operation).is_err());
    }

    #[test]
    fn bootstrap_exact_witness_and_journal_fence_rejects_concurrent_drift() {
        use crate::operation::OperationStore;
        let temporary = tempfile::tempdir().unwrap();
        let (library, operation, journal, witness, _, _) = bootstrap_fixture(temporary.path());
        let store = OperationStore::new(library.clone());
        store
            .commit_psx_bootstrap(&journal, &witness, &operation)
            .unwrap();
        let result = store.psx_bootstrap_before_fence(&operation, || {
            library.connection()?.execute("UPDATE managed_psx_bootstrap SET witness_json=witness_json || ' ' WHERE operation_id=?1", [&journal.id])?;
            Ok(())
        });
        assert!(result.is_err());
    }

    #[test]
    fn bootstrap_generation_requires_loaded_exact_predecessor_and_unchanged_request() {
        use crate::operation::OperationStore;
        let temporary = tempfile::tempdir().unwrap();
        let (library, operation, journal, bootstrap, generated, mut preparation) =
            bootstrap_fixture(temporary.path());
        assert!(bootstrap.binding().is_err());
        let store = OperationStore::new(library.clone());
        store
            .commit_psx_bootstrap(&journal, &bootstrap, &operation)
            .unwrap();
        let loaded = store.psx_bootstrap(&operation).unwrap();
        loaded
            .require_request(&serde_json::json!({"inert":true}), &preparation)
            .unwrap();
        preparation.executable_basename.push_str("-changed");
        assert!(
            loaded
                .require_request(&serde_json::json!({"inert":true}), &preparation)
                .is_err()
        );
        let bound = generated.with_bootstrap(loaded.binding().unwrap());
        store
            .commit_psx_generation(&journal, &bound, &operation)
            .unwrap();
        let reopened = store.psx_generation(&operation).unwrap();
        assert_eq!(reopened.bootstrap_parent(), bound.bootstrap_parent());
        library.connection().unwrap().execute("UPDATE managed_psx_bootstrap SET witness_json=witness_json || ' ' WHERE operation_id=?1", [&journal.id]).unwrap();
        assert!(store.psx_generation(&operation).is_err());
    }

    #[test]
    fn bootstrap_generation_vacancy_refuses_replay_before_worker_dispatch() {
        use crate::operation::OperationStore;
        let temporary = tempfile::tempdir().unwrap();
        let (library, operation, journal, bootstrap, generated, preparation) =
            bootstrap_fixture(temporary.path());
        let store = OperationStore::new(library.clone());
        store
            .commit_psx_bootstrap(&journal, &bootstrap, &operation)
            .unwrap();
        let loaded = store.psx_bootstrap(&operation).unwrap();
        store.require_psx_generation_vacant(&operation).unwrap();
        let binding = loaded.binding().unwrap();
        store
            .commit_psx_generation(&journal, &generated.with_bootstrap(binding), &operation)
            .unwrap();
        assert!(store.require_psx_generation_vacant(&operation).is_err());
        let before = fs::read(
            journal
                .paths
                .staging
                .as_ref()
                .unwrap()
                .join("payload/generated.c"),
        )
        .unwrap();
        let (result, quiesced) = loaded.generate(&library, &journal, &preparation, &operation);
        assert_eq!(
            result.err().unwrap().message,
            "PS1 acquired generation already advanced"
        );
        assert!(quiesced);
        assert_eq!(
            before,
            fs::read(
                journal
                    .paths
                    .staging
                    .as_ref()
                    .unwrap()
                    .join("payload/generated.c")
            )
            .unwrap()
        );
    }

    #[test]
    fn bootstrap_optional_binding_preserves_legacy_generation_bytes() {
        let temporary = tempfile::tempdir().unwrap();
        let (_, _, _, generated, _) = generation_witness_fixture(temporary.path());
        let json = crate::operation::psx_witness_json(&generated).unwrap();
        assert!(
            serde_json::from_str::<serde_json::Value>(&json)
                .unwrap()
                .get("bootstrap")
                .is_none()
        );
        let reopened: GeneratedInstallWitness = serde_json::from_str(&json).unwrap();
        assert_eq!(json, crate::operation::psx_witness_json(&reopened).unwrap());
    }

    #[test]
    fn bootstrap_generation_fence_refuses_predecessor_drift_after_filesystem_verification() {
        use crate::operation::OperationStore;
        let temporary = tempfile::tempdir().unwrap();
        let (library, operation, journal, bootstrap, generated, _) =
            bootstrap_fixture(temporary.path());
        let store = OperationStore::new(library.clone());
        store
            .commit_psx_bootstrap(&journal, &bootstrap, &operation)
            .unwrap();
        let loaded = store.psx_bootstrap(&operation).unwrap();
        store
            .commit_psx_generation(
                &journal,
                &generated.with_bootstrap(loaded.binding().unwrap()),
                &operation,
            )
            .unwrap();
        let result = store.psx_generation_before_fence(&operation, || {
            library.connection()?.execute("UPDATE managed_psx_bootstrap SET witness_json=witness_json || ' ' WHERE operation_id=?1", [&journal.id])?;
            Ok(())
        });
        assert!(result.is_err());
        assert!(library.all_installs().unwrap().is_empty());
    }

    #[test]
    fn configuration_witness_roundtrip_keeps_generation_and_private_ownership() {
        use crate::operation::OperationStore;
        let temporary = tempfile::tempdir().unwrap();
        let (library, operation, journal, configured) =
            configuration_witness_fixture(temporary.path());
        let store = OperationStore::new(library.clone());
        let before: String = library
            .connection()
            .unwrap()
            .query_row(
                "SELECT witness_json FROM managed_psx_generation WHERE operation_id=?1",
                [&journal.id],
                |row| row.get(0),
            )
            .unwrap();
        store
            .commit_psx_configuration(&journal, &configured, &operation)
            .unwrap();
        let reopened = Library::open(library.root()).unwrap();
        crate::PortcoveService::new(reopened.clone()).unwrap();
        let continuation = crate::Installer::new(reopened.clone())
            .unwrap()
            .managed_install_configured(&operation)
            .unwrap();
        assert_eq!(continuation.operation_id, journal.id);
        assert_eq!(continuation.port_id, journal.port_id);
        assert!(reopened.all_installs().unwrap().is_empty());
        assert!(!journal.paths.final_path.unwrap().exists());
        assert!(
            !journal
                .paths
                .staging
                .unwrap()
                .join("payload/.portcove-managed.json")
                .exists()
        );
        let after: String = reopened
            .connection()
            .unwrap()
            .query_row(
                "SELECT witness_json FROM managed_psx_generation WHERE operation_id=?1",
                [&journal.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(before, after);
        assert!(
            store
                .commit_psx_configuration(
                    &store.get(&journal.id).unwrap().unwrap(),
                    &configured,
                    &operation
                )
                .is_err()
        );
    }

    pub(super) fn configuration_witness_fixture(
        root: &Path,
    ) -> (
        Library,
        OperationCoordinator,
        crate::operation::LifecycleOperation,
        ConfiguredInstallWitness,
    ) {
        configuration_witness_fixture_acquired(root, false)
    }

    pub(super) fn configuration_witness_fixture_acquired(
        root: &Path,
        acquired: bool,
    ) -> (
        Library,
        OperationCoordinator,
        crate::operation::LifecycleOperation,
        ConfiguredInstallWitness,
    ) {
        configuration_witness_fixture_ancestry(root, acquired, false)
    }

    fn configuration_witness_fixture_ancestry(
        root: &Path,
        acquired: bool,
        normalized: bool,
    ) -> (
        Library,
        OperationCoordinator,
        crate::operation::LifecycleOperation,
        ConfiguredInstallWitness,
    ) {
        use crate::operation::OperationStore;
        let (library, operation, journal, generation, preparation) = if normalized {
            let (library, operation, journal, candidate, preparation) =
                provisional_generation_fixture(root);
            let store = OperationStore::new(library.clone());
            store
                .commit_psx_pending_generation(&journal, &candidate, &operation)
                .unwrap();
            store
                .seal_psx_generation(
                    &journal,
                    store.psx_pending_generation(&operation).unwrap(),
                    &operation,
                )
                .unwrap();
            let generation = store.psx_generation(&operation).unwrap();
            (library, operation, journal, generation, preparation)
        } else if acquired {
            let (library, operation, journal, bootstrap, generation, preparation) =
                bootstrap_fixture(root);
            let store = OperationStore::new(library.clone());
            store
                .commit_psx_bootstrap(&journal, &bootstrap, &operation)
                .unwrap();
            let loaded = store.psx_bootstrap(&operation).unwrap();
            let generation = generation.with_bootstrap(loaded.binding().unwrap());
            (library, operation, journal, generation, preparation)
        } else {
            generation_witness_fixture(root)
        };
        let store = OperationStore::new(library.clone());
        if !normalized {
            store
                .commit_psx_generation(&journal, &generation, &operation)
                .unwrap();
        }
        let generation = store.psx_generation(&operation).unwrap();
        let generation_sha256 = generation.persisted_sha256.clone().unwrap();
        let payload = generation.generated.tree.root();
        let build = payload.join("build-portcove");
        fs::create_dir(&build).unwrap();
        fs::write(
            build.join("build.ninja"),
            format!("# Inert graph; no configure execution\ninclude CMakeFiles/rules.ninja\nbuild {}: LINK\nbuild psx-runtime: phony {}\n", platform_executable(Path::new(""), &preparation.executable_basename).display(), platform_executable(Path::new(""), &preparation.executable_basename).display()),
        )
        .unwrap();
        fs::create_dir(build.join("CMakeFiles")).unwrap();
        fs::write(
            build.join("CMakeFiles/rules.ninja"),
            "# Inert rules; no native execution\nrule LINK\n  command = not-executed\n",
        )
        .unwrap();
        fs::write(
            build.join("CMakeCache.txt"),
            "inert cache; no configure execution",
        )
        .unwrap();
        let tree = generation
            .generated
            .tree
            .configured_transition(payload, &operation, true)
            .unwrap();
        let arguments = configure_arguments(payload, &build, &preparation.toolchain_root).unwrap();
        let compile_plan =
            compile_plan::derive(payload, &preparation.executable_basename, &operation).unwrap();
        let configured = ConfiguredInstallWitness {
            generation,
            generation_sha256,
            persisted_sha256: None,
            configured: ConfiguredInstall {
                tree,
                arguments,
                compile_plan,
            },
        };
        (library, operation, journal, configured)
    }

    fn failed_configuration_fixture(
        root: &Path,
    ) -> (
        Library,
        OperationCoordinator,
        crate::operation::LifecycleOperation,
        ConfiguredInstallWitness,
    ) {
        let (library, operation, mut journal, configured) =
            configuration_witness_fixture_ancestry(root, false, true);
        journal.last_error = Some("retained configure failure".into());
        crate::operation::OperationStore::new(library.clone())
            .put(&mut journal)
            .unwrap();
        (library, operation, journal, configured)
    }

    #[test]
    #[cfg(feature = "qualification-fixtures")]
    fn failed_configuration_contract_uses_closed_context_without_acknowledgement() {
        let temporary = tempfile::tempdir().unwrap();
        let (library, operation, journal, configured) =
            failed_configuration_fixture(temporary.path());
        let store = crate::operation::OperationStore::new(library.clone());
        assert!(
            store
                .psx_historical_qualification_contract(&operation, false)
                .is_err()
        );
        assert_eq!(
            store
                .psx_historical_configuration_contract(&operation)
                .unwrap(),
            configured.generation.contract
        );
        assert_eq!(
            store.get(&journal.id).unwrap().unwrap().last_error,
            journal.last_error
        );
        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE lifecycle_operations SET preparation_process_quiesced=0 WHERE id=?1",
                [&journal.id],
            )
            .unwrap();
        assert!(
            store
                .psx_historical_configuration_contract(&operation)
                .is_err()
        );
        assert!(
            store
                .psx_historical_qualification_contract(&operation, false)
                .is_err()
        );
    }

    #[test]
    fn failed_configuration_start_and_promotion_preserve_exact_generation() {
        let temporary = tempfile::tempdir().unwrap();
        let (library, operation, journal, configured) =
            failed_configuration_fixture(temporary.path());
        let store = crate::operation::OperationStore::new(library.clone());
        let original: (String, String) = library
            .connection()
            .unwrap()
            .query_row(
                "SELECT witness_json,witness_sha256 FROM managed_psx_generation",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert!(store.psx_generation(&operation).is_err());
        let mut context = store.psx_failed_configuration(&operation).unwrap();
        assert!(
            store
                .commit_psx_recovered_configuration(
                    &journal,
                    &configured,
                    context.bindings_for_fixture(),
                    &operation
                )
                .is_err()
        );
        let started = store
            .start_psx_configuration(&mut context, &operation)
            .unwrap();
        assert_eq!(started.last_error, journal.last_error);
        assert_eq!(started.preparation_process_quiesced, Some(false));
        assert!(
            store
                .start_psx_configuration(&mut context, &operation)
                .is_err()
        );
        assert!(store.psx_failed_configuration(&operation).is_err());
        let mut completed = started.clone();
        completed.preparation_process_quiesced = Some(true);
        store
            .put_psx_configuration_outcome(&started, &mut completed)
            .unwrap();
        assert_eq!(
            store.get(&journal.id).unwrap().unwrap().last_error,
            journal.last_error
        );
        // A synthetic, fully captured fixture checks store atomicity only;
        // it is deliberately not native configuration or installation proof.
        store
            .commit_psx_recovered_configuration(
                &completed,
                &configured,
                context.bindings_for_fixture(),
                &operation,
            )
            .unwrap();
        assert!(
            store
                .get(&journal.id)
                .unwrap()
                .unwrap()
                .last_error
                .is_none()
        );
        assert!(store.psx_configuration(&operation).is_ok());
        let after: (String, String) = library
            .connection()
            .unwrap()
            .query_row(
                "SELECT witness_json,witness_sha256 FROM managed_psx_generation",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(after, original);
        assert!(store.psx_failed_configuration(&operation).is_err());
        assert!(library.all_installs().unwrap().is_empty());
    }

    #[test]
    fn failed_configuration_promotion_refusals_do_not_acknowledge_owner() {
        for change in ["closure", "parent", "insert"] {
            let temporary = tempfile::tempdir().unwrap();
            let (library, operation, journal, configured) =
                failed_configuration_fixture(temporary.path());
            let store = crate::operation::OperationStore::new(library.clone());
            let mut context = store.psx_failed_configuration(&operation).unwrap();
            let started = store
                .start_psx_configuration(&mut context, &operation)
                .unwrap();
            let mut completed = started.clone();
            completed.preparation_process_quiesced = Some(change != "closure");
            store
                .put_psx_configuration_outcome(&started, &mut completed)
                .unwrap();
            let connection = library.connection().unwrap();
            match change {
                "parent" => {
                    connection.execute("UPDATE managed_psx_pending_generation SET witness_json=witness_json||' '", []).unwrap();
                }
                "insert" => {
                    connection.execute_batch("CREATE TRIGGER refuse_configuration BEFORE INSERT ON managed_psx_configuration BEGIN SELECT RAISE(ABORT,'inert configuration retention refusal'); END;").unwrap();
                }
                _ => {}
            }
            assert!(
                store
                    .commit_psx_recovered_configuration(
                        &completed,
                        &configured,
                        context.bindings_for_fixture(),
                        &operation
                    )
                    .is_err(),
                "{change}"
            );
            assert_eq!(
                store.get(&journal.id).unwrap().unwrap().last_error,
                journal.last_error
            );
            assert_eq!(
                connection
                    .query_row(
                        "SELECT COUNT(*) FROM managed_psx_configuration",
                        [],
                        |row| row.get::<_, i64>(0)
                    )
                    .unwrap(),
                0
            );
        }
    }

    #[test]
    fn failed_configuration_start_refuses_journal_and_pending_drift() {
        use sha2::Digest;
        for change in ["journal", "pending", "closure"] {
            let temporary = tempfile::tempdir().unwrap();
            let (library, operation, journal, _) = failed_configuration_fixture(temporary.path());
            let store = crate::operation::OperationStore::new(library.clone());
            let mut context = store.psx_failed_configuration(&operation).unwrap();
            let connection = library.connection().unwrap();
            match change {
                "journal" => {
                    connection
                        .execute(
                            "UPDATE lifecycle_operations SET activate=1-activate WHERE id=?1",
                            [&journal.id],
                        )
                        .unwrap();
                }
                "closure" => {
                    connection.execute("UPDATE lifecycle_operations SET preparation_process_quiesced=0 WHERE id=?1", [&journal.id]).unwrap();
                }
                _ => {
                    let raw: String = connection
                        .query_row(
                            "SELECT witness_json FROM managed_psx_pending_generation",
                            [],
                            |row| row.get(0),
                        )
                        .unwrap();
                    let changed = format!("{raw} ");
                    connection.execute("UPDATE managed_psx_pending_generation SET witness_json=?1,witness_sha256=?2", rusqlite::params![changed, hex::encode(sha2::Sha256::digest(changed.as_bytes()))]).unwrap();
                }
            }
            let before = store.get(&journal.id).unwrap().unwrap();
            assert!(
                store
                    .start_psx_configuration(&mut context, &operation)
                    .is_err()
            );
            let after = store.get(&journal.id).unwrap().unwrap();
            assert_eq!(
                crate::operation::psx_journal_for_fixture(&after).unwrap(),
                crate::operation::psx_journal_for_fixture(&before).unwrap()
            );
            assert!(!configuration_failure_path(&journal).unwrap().exists());
        }
    }

    #[test]
    fn failed_configuration_refuses_restored_timestamp_content_mutation() {
        let temporary = tempfile::tempdir().unwrap();
        let (library, operation, journal, _) = failed_configuration_fixture(temporary.path());
        let config = journal
            .paths
            .staging
            .as_ref()
            .unwrap()
            .join("payload/game.toml");
        let modified = fs::metadata(&config).unwrap().modified().unwrap();
        let mut bytes = fs::read(&config).unwrap();
        bytes[1] ^= 1;
        fs::write(&config, &bytes).unwrap();
        fs::File::options()
            .write(true)
            .open(&config)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(modified))
            .unwrap();
        assert_eq!(fs::metadata(&config).unwrap().modified().unwrap(), modified);
        assert!(
            crate::operation::OperationStore::new(library)
                .psx_failed_configuration(&operation)
                .is_err()
        );
        assert!(!configuration_failure_path(&journal).unwrap().exists());
    }

    #[test]
    fn failed_configuration_evidence_holds_both_failed_and_clean_admission() {
        let temporary = tempfile::tempdir().unwrap();
        let (library, operation, mut journal, _) = failed_configuration_fixture(temporary.path());
        fs::create_dir(configuration_failure_path(&journal).unwrap()).unwrap();
        assert!(require_fresh_configuration_attempt(&journal).is_err());
        assert!(
            crate::operation::OperationStore::new(library)
                .psx_failed_configuration(&operation)
                .is_err()
        );
        journal.last_error = None;
        assert!(require_fresh_configuration_attempt(&journal).is_err());
    }

    #[test]
    fn failed_configuration_preserves_partial_outputs_before_builder_failure() {
        let temporary = tempfile::tempdir().unwrap();
        let (library, operation, journal, configured) =
            failed_configuration_fixture(temporary.path());
        let preparation =
            preparation_from_identity(&configured.generation.generated.inputs).unwrap();
        let store = crate::operation::OperationStore::new(library.clone());
        let mut context = store.psx_failed_configuration(&operation).unwrap();
        let started = store
            .start_psx_configuration(&mut context, &operation)
            .unwrap();
        let payload = configured.generation.generated.tree.root();
        let original_cache = fs::read(payload.join("build-portcove/CMakeCache.txt")).unwrap();
        let (result, quiesced) = context.configure(&library, &preparation, &operation);
        assert!(result.is_err(), "inert fixture CMake cannot execute");
        assert!(
            quiesced,
            "spawn refusal positively closes a process-free worker"
        );
        let evidence = configuration_failure_path(&journal).unwrap();
        let prior: serde_json::Value =
            serde_json::from_slice(&fs::read(evidence.join("prior.json")).unwrap()).unwrap();
        assert_eq!(
            prior["prior_journal"][12],
            journal.last_error.as_ref().unwrap().as_str()
        );
        assert_eq!(prior["prior_journal"][16], 1);
        assert_eq!(
            fs::read(evidence.join("outputs/build-portcove/CMakeCache.txt")).unwrap(),
            original_cache
        );
        assert!(evidence.join("outputs.json").is_file());
        assert!(!payload.join("build-portcove").exists());
        let mut completed = started.clone();
        completed.preparation_process_quiesced = Some(quiesced);
        store
            .put_psx_configuration_outcome(&started, &mut completed)
            .unwrap();
        assert_eq!(completed.last_error, journal.last_error);
        assert!(store.psx_failed_configuration(&operation).is_err());
        assert!(library.all_installs().unwrap().is_empty());
    }

    #[test]
    fn pending_generation_binding_omission_with_recomputed_hash_refuses_generation_and_configuration()
     {
        use sha2::Digest;
        for stage in ["generation", "configuration"] {
            let temporary = tempfile::tempdir().unwrap();
            let (library, operation, journal, configured) =
                configuration_witness_fixture_ancestry(temporary.path(), false, true);
            let store = crate::operation::OperationStore::new(library.clone());
            store
                .commit_psx_configuration(&journal, &configured, &operation)
                .unwrap();
            assert!(store.psx_configuration(&operation).is_ok());
            let connection = library.connection().unwrap();
            let mut generation = serde_json::to_value(&configured.generation).unwrap();
            assert!(
                generation
                    .as_object_mut()
                    .unwrap()
                    .remove("normalized")
                    .is_some()
            );
            let changed_generation: GeneratedInstallWitness =
                serde_json::from_value(generation.clone()).unwrap();
            let generation_json = crate::operation::psx_witness_json(&changed_generation).unwrap();
            let generation_sha = hex::encode(sha2::Sha256::digest(generation_json.as_bytes()));
            connection.execute("UPDATE managed_psx_generation SET witness_json=?1,witness_sha256=?2 WHERE operation_id=?3", rusqlite::params![generation_json, generation_sha, operation.operation_id()]).unwrap();
            if stage == "configuration" {
                let mut value = serde_json::to_value(&configured).unwrap();
                value["generation"] = generation;
                value["generation_sha256"] = serde_json::json!(generation_sha);
                let changed_configuration: ConfiguredInstallWitness =
                    serde_json::from_value(value).unwrap();
                let json = crate::operation::psx_witness_json(&changed_configuration).unwrap();
                let sha = hex::encode(sha2::Sha256::digest(json.as_bytes()));
                connection.execute("UPDATE managed_psx_configuration SET witness_json=?1,witness_sha256=?2 WHERE operation_id=?3", rusqlite::params![json, sha, operation.operation_id()]).unwrap();
                let error = store.psx_configuration(&operation).err().unwrap();
                assert!(
                    error
                        .message
                        .contains("normalized generation ancestry is missing"),
                    "{error:?}"
                );
            } else {
                // Generation has already transitioned to configured output, so
                // assert the explicit ancestry error precedes that other refusal.
                let error = store.psx_generation(&operation).err().unwrap();
                assert!(
                    error
                        .message
                        .contains("normalized generation ancestry is missing"),
                    "{error:?}"
                );
            }
            assert!(library.all_installs().unwrap().is_empty());
            assert!(!journal.paths.final_path.as_ref().unwrap().exists());
        }
        // The existing legacy fixture has no normalized ancestor and remains
        // readable without synthesizing a binding it never possessed.
        let legacy = tempfile::tempdir().unwrap();
        let (library, operation, journal, configured) =
            configuration_witness_fixture(legacy.path());
        let store = crate::operation::OperationStore::new(library);
        store
            .commit_psx_configuration(&journal, &configured, &operation)
            .unwrap();
        assert!(store.psx_configuration(&operation).is_ok());
    }

    #[test]
    fn configuration_pending_query_refuses_unloaded_evidence_and_unknown_batch_before_native() {
        use crate::operation::OperationStore;
        let temporary = tempfile::tempdir().unwrap();
        let (library, operation, journal, configured) =
            configuration_witness_fixture(temporary.path());
        let preparation =
            preparation_from_identity(&configured.generation.generated.inputs).unwrap();
        let store = OperationStore::new(library.clone());
        store
            .commit_psx_configuration(&journal, &configured, &operation)
            .unwrap();
        let (result, quiesced) = configured.observe_pending(&preparation, 0, &operation);
        assert!(result.is_err());
        assert!(quiesced);
        let loaded = store.psx_configuration(&operation).unwrap();
        assert!(loaded.persisted_sha256.is_some());
        let bytes = serde_json::to_vec(&loaded).unwrap();
        let reconstructed: ConfiguredInstallWitness = serde_json::from_slice(&bytes).unwrap();
        assert!(reconstructed.persisted_sha256.is_none());
        let (result, quiesced) = loaded.observe_pending(&preparation, usize::MAX, &operation);
        assert!(result.is_err());
        assert!(quiesced);
        assert!(library.all_installs().unwrap().is_empty());
        assert!(store.psx_configuration(&operation).is_ok());
        assert!(!journal.paths.final_path.unwrap().exists());
    }

    #[test]
    fn configuration_witness_refuses_uncertain_closure_and_parent_drift() {
        use crate::operation::OperationStore;
        let temporary = tempfile::tempdir().unwrap();
        let (library, operation, mut journal, configured) =
            configuration_witness_fixture(temporary.path());
        let store = OperationStore::new(library.clone());
        journal.preparation_process_quiesced = Some(false);
        store.put(&mut journal).unwrap();
        assert!(
            store
                .commit_psx_configuration(&journal, &configured, &operation)
                .is_err()
        );
        journal.preparation_process_quiesced = Some(true);
        store.put(&mut journal).unwrap();
        store
            .commit_psx_configuration(&journal, &configured, &operation)
            .unwrap();
        library.connection().unwrap().execute("UPDATE managed_psx_generation SET witness_json=witness_json || ' ' WHERE operation_id=?1", [&journal.id]).unwrap();
        assert!(store.psx_configuration(&operation).is_err());
        let count: i64 = library
            .connection()
            .unwrap()
            .query_row(
                "SELECT count(*) FROM managed_psx_configuration",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
        assert!(store.get(&journal.id).unwrap().is_some());
    }

    #[test]
    fn configuration_witness_refuses_parent_drift_during_verification_and_cascades_with_owner() {
        use crate::operation::OperationStore;
        let temporary = tempfile::tempdir().unwrap();
        let (library, operation, journal, configured) =
            configuration_witness_fixture(temporary.path());
        let store = OperationStore::new(library.clone());
        store
            .commit_psx_configuration(&journal, &configured, &operation)
            .unwrap();
        assert!(store.psx_configuration_before_fence(&operation, || {
            library.connection()?.execute("UPDATE managed_psx_generation SET witness_json=witness_json || ' ' WHERE operation_id=?1", [&journal.id])?;
            Ok(())
        }).is_err());
        assert!(store.get(&journal.id).unwrap().is_some());
        store.remove(&journal.id).unwrap();
        let count: i64 = library.connection().unwrap().query_row("SELECT (SELECT count(*) FROM managed_psx_generation)+(SELECT count(*) FROM managed_psx_configuration)", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 0);
        assert!(
            journal
                .paths
                .staging
                .unwrap()
                .join("payload/build-portcove/build.ninja")
                .is_file()
        );
    }

    #[test]
    fn configuration_witness_refuses_generated_and_configured_input_drift() {
        use crate::operation::OperationStore;
        let temporary = tempfile::tempdir().unwrap();
        let (library, operation, journal, configured) =
            configuration_witness_fixture(temporary.path());
        let store = OperationStore::new(library.clone());
        store
            .commit_psx_configuration(&journal, &configured, &operation)
            .unwrap();
        let payload = journal.paths.staging.unwrap().join("payload");
        fs::write(payload.join("build-portcove/build.ninja"), "changed graph").unwrap();
        assert!(store.psx_configuration(&operation).is_err());
        assert!(library.all_installs().unwrap().is_empty());
    }

    #[test]
    fn configure_stage_refuses_changed_generation_before_any_tool_or_output() {
        let temporary = tempfile::tempdir().unwrap();
        let (_, operation, journal, witness, preparation) =
            generation_witness_fixture(temporary.path());
        let root = journal.paths.staging.unwrap().join("payload");
        fs::write(root.join("generated.c"), "changed generated source").unwrap();
        let (result, quiesced) =
            configure_install_stage(&root, &preparation, &operation, &witness.generated);
        assert!(result.is_err());
        assert!(quiesced);
        assert!(!root.join("build-portcove").exists());
        assert!(!root.join(".portcove-builder-environment").exists());
        assert!(!root.join(".portcove-managed.json").exists());
    }

    #[cfg(windows)]
    #[test]
    fn configure_paths_bind_canonical_objects_with_command_shell_spelling() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("payload with spaces");
        fs::create_dir(&root).unwrap();
        let toolchain = temporary.path().join("toolchain");
        toolchain_fixture(&toolchain, None);
        for name in ["clang", "clang++"] {
            fs::write(platform_executable(&toolchain.join("bin"), name), "inert").unwrap();
        }
        let canonical = fs::canonicalize(&root).unwrap();
        let pinned = fs::canonicalize(&toolchain).unwrap();
        let build = canonical.join("build-portcove");
        let arguments = configure_arguments(&canonical, &build, &pinned).unwrap();
        for argument in &arguments {
            assert!(
                !argument.contains(r"\\?\"),
                "shell alias leaked: {argument}"
            );
        }
        assert_eq!(fs::canonicalize(&arguments[1]).unwrap(), canonical);
        assert_eq!(
            crate::path::resolve_existing_ancestor(Path::new(&arguments[3])).unwrap(),
            build
        );
        let mut command =
            // Existing Windows test infrastructure resolves this literal with
            // GetSystemDirectoryW, without ambient PATH or a mixed-slash alias.
            ChildProcessPolicy::native_tool_spec(ChildProcessClass::ManagedBuilder, "cmd.exe")
                .unwrap();
        command
            // cmd.exe parses a command string rather than native argv. This
            // static test-only argument contains no path or interpolated text.
            .raw_arg("/D /C cd")
            .current_dir(builder_path(&canonical).unwrap());
        let mut quiesced = false;
        let output = crate::tool_process::run_tool(
            &mut command,
            &|| Ok(()),
            crate::tool_process::ToolProcessObserver {
                diagnostics: None,
                quiesced: Some(&mut || {
                    quiesced = true;
                    Ok(())
                }),
            },
        )
        .unwrap();
        assert!(
            output.status.success(),
            "{}: {}",
            output.status,
            output.output
        );
        assert!(quiesced);
        assert_eq!(fs::canonicalize(output.output.trim()).unwrap(), canonical);
    }

    #[cfg(windows)]
    #[test]
    fn configure_paths_refuse_unc_before_network_inspection() {
        for path in [
            r"\\unreachable.invalid\share\payload",
            r"\\?\UNC\unreachable.invalid\share\payload",
        ] {
            assert_eq!(
                builder_path(Path::new(path)).unwrap_err().code,
                crate::ErrorCode::Unsupported
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn configure_paths_refuse_changed_symlink_ancestors() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let linked = root.path().join("linked");
        std::os::unix::fs::symlink(outside.path(), &linked).unwrap();
        assert!(builder_path(&linked.join("future-build")).is_err());
    }

    #[test]
    fn configure_stage_pins_playable_recipe_and_refuses_missing_compiler() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("payload");
        let toolchain = temporary.path().join("toolchain");
        toolchain_fixture(&toolchain, None);
        let build = root.join("build-portcove");
        assert!(configure_arguments(&root, &build, &toolchain).is_err());
        for name in ["clang", "clang++"] {
            fs::write(
                platform_executable(&toolchain.join("bin"), name),
                "inert compiler; not executed",
            )
            .unwrap();
        }
        let arguments = configure_arguments(&root, &build, &toolchain).unwrap();
        assert_eq!(
            &arguments[..6],
            &[
                "-S",
                root.to_str().unwrap(),
                "-B",
                build.to_str().unwrap(),
                "-G",
                "Ninja"
            ]
        );
        for required in [
            "-DCMAKE_BUILD_TYPE=Release",
            "-DCMAKE_SUPPRESS_REGENERATION=ON",
            "-DPSX_PGO=",
            "-DPSXRECOMP_FORCE_SETUP_HOST=OFF",
            "-DBPE_FORCE_SETUP_HOST=OFF",
            "-DPSXRECOMP_REQUIRE_GAME_C=ON",
            "-DPSXRECOMP_ALLOW_NO_BIOS=OFF",
            "-DPSX_DEBUG_TOOLS=OFF",
            "-DCMAKE_C_COMPILER_LAUNCHER:STRING=",
            "-DCMAKE_CXX_COMPILER_LAUNCHER:STRING=",
        ] {
            assert!(arguments.iter().any(|value| value == required));
        }
        assert!(arguments.iter().any(|value| value
            == &format!(
                "-DPython3_EXECUTABLE={}",
                builder_path(&toolchain_python(&toolchain).unwrap()).unwrap()
            )));
        assert!(
            !arguments
                .iter()
                .any(|value| value == "--build" || value == "rebuild")
        );
        assert!(arguments.iter().any(|value| value
            == &format!(
                "-DCMAKE_C_COMPILER={}",
                platform_executable(&toolchain.join("bin"), "clang").display()
            )));
        fs::remove_file(platform_executable(&toolchain.join("bin"), "clang")).unwrap();
        assert!(configure_arguments(&root, &build, &toolchain).is_err());
    }

    #[test]
    fn configure_cache_requires_unique_pinned_python_and_immutable_graph_policy() {
        let temporary = tempfile::tempdir().unwrap();
        let toolchain = temporary.path().join("toolchain");
        toolchain_fixture(&toolchain, None);
        let build = temporary.path().join("build");
        fs::create_dir(&build).unwrap();
        let cache = format!(
            "CMAKE_SUPPRESS_REGENERATION:BOOL=ON\nPython3_EXECUTABLE:FILEPATH={}\n",
            builder_path(&toolchain_python(&toolchain).unwrap()).unwrap()
        );
        fs::write(build.join("CMakeCache.txt"), &cache).unwrap();
        verify_configure_cache(&build, &toolchain).unwrap();
        for invalid in [
            cache.replace("=ON", "=OFF"),
            cache.replace("Python3_EXECUTABLE:", "_Python3_EXECUTABLE:"),
            cache.clone() + "Python3_EXECUTABLE:FILEPATH=foreign/python\n",
        ] {
            fs::write(build.join("CMakeCache.txt"), invalid).unwrap();
            assert!(verify_configure_cache(&build, &toolchain).is_err());
        }
    }

    // Explicit representative native diagnostic, through the production builder
    // and closure boundary. Uses only a copied pinned Ninja and private fixtures;
    // no failed operation, database, SDK build or game source is opened.
    #[cfg(windows)]
    #[test]
    #[ignore = "explicit pinned-Ninja qualification fixture"]
    fn ninja_native_manifest_and_repeatable_completion_control() {
        let pinned = PathBuf::from(
            std::env::var_os("PORTCOVE_QUALIFICATION_NINJA").expect("explicit pinned Ninja"),
        );
        assert_eq!(
            hex::encode(sha2::Sha256::digest(
                crate::external_runtime::read_stable_metadata(&pinned, 1024 * 1024).unwrap()
            )),
            "e52a7ad9538d9618c67a0bd777964e2eec8a30f68b810a2f6adce1f2daf847b8"
        );
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path();
        let toolchain = root.join("owned-toolchain");
        toolchain_fixture(&toolchain, Some(&pinned));
        let ninja = platform_executable(&toolchain.join("bin"), "ninja");
        let build = root.join("build-portcove");
        fs::create_dir(&build).unwrap();
        let graph = format!(
            "cmake_ninja_workdir = {}/\ninclude CMakeFiles/rules.ninja\nrule MATERIAL\n  command = cmd.exe /C echo fixture>first.obj\nrule CUSTOM_COMMAND\n  command = $COMMAND\nrule VERIFY_GLOBS\n  command = cmd.exe /C exit 0\n  generator = 1\n  restat = 1\nrule RERUN_CMAKE\n  command = cmd.exe /C exit 0\n  generator = 1\nbuild first.obj: MATERIAL\nbuild CMakeFiles/psx-stage-configs.util: CUSTOM_COMMAND\n  COMMAND = cmd.exe /C \"copy /Y ..\\game.toml game.toml >NUL && copy /Y ..\\game_options.toml game_options.toml >NUL\"\nbuild CMakeFiles/psx-runtime_require_generated | ${{cmake_ninja_workdir}}CMakeFiles/psx-runtime_require_generated: CUSTOM_COMMAND\n  COMMAND = cmd.exe /C exit 0\nbuild game.exe: phony first.obj CMakeFiles/psx-stage-configs.util CMakeFiles/psx-runtime_require_generated\nbuild psx-runtime: phony game.exe\n",
            builder_path(&build)
                .unwrap()
                .replace('\\', "/")
                .replace(':', "$:")
                .replace(' ', "$ ")
        );
        fs::create_dir(build.join("CMakeFiles")).unwrap();
        fs::write(build.join("CMakeFiles/rules.ninja"), "# owned fixture\n").unwrap();
        for name in ["game.toml", "game_options.toml"] {
            fs::write(root.join(name), b"owned configuration").unwrap();
        }
        let regeneration = "build force: phony\nbuild glob: VERIFY_GLOBS force\nbuild build.ninja: RERUN_CMAKE glob\n";
        fs::write(build.join("build.ninja"), graph.clone() + regeneration).unwrap();
        let operation = OperationCoordinator::new("native-pending-control", None);
        let targets = vec!["game.exe".into()];
        let mut quiesced = true;
        let capture = |dry, quiesced: &mut bool| {
            capture_pinned_builder(
                &ninja,
                root,
                &toolchain,
                pending::arguments(&targets, dry),
                &operation,
                quiesced,
                true,
            )
            .unwrap()
        };
        let manifest_only = capture(true, &mut quiesced);
        assert!(quiesced);
        assert_eq!(pending::inspect(&manifest_only, quiesced).unwrap().count, 2);
        assert!(!manifest_only.stdout.text.contains("echo fixture"));
        assert!(!build.join("first.obj").exists());
        fs::write(build.join("build.ninja"), &graph).unwrap();
        assert_eq!(
            pending::inspect(&capture(true, &mut quiesced), quiesced)
                .unwrap()
                .count,
            3
        );
        capture(false, &mut quiesced);
        assert!(quiesced);
        assert!(build.join("first.obj").is_file());
        let after = pending::inspect(&capture(true, &mut quiesced), quiesced).unwrap();
        assert_eq!(after.count, 2);
        let tree = stage::GeneratedTree::capture(root, &operation, quiesced).unwrap();
        assert_eq!(
            pending::material_remaining(&after, &tree, "game.exe", &targets, &operation).unwrap(),
            0
        );
        println!(
            "native Ninja control: manifest-only=2; fresh-target=3; executed material=1; repeatable=2; remaining material=0; positive closure=true"
        );
    }

    #[test]
    fn generation_witness_refuses_destination_activation_and_library_drift() {
        use crate::operation::OperationStore;
        let temporary = tempfile::tempdir().unwrap();
        let (library, operation, mut journal, witness, _) =
            generation_witness_fixture(temporary.path());
        let store = OperationStore::new(library.clone());
        store
            .commit_psx_generation(&journal, &witness, &operation)
            .unwrap();
        let original = journal.clone();
        journal.paths.final_path = Some(temporary.path().join("different-destination"));
        store.put(&mut journal).unwrap();
        assert!(store.psx_generation(&operation).is_err());
        journal = original.clone();
        journal.activate = !journal.activate;
        store.put(&mut journal).unwrap();
        assert!(store.psx_generation(&operation).is_err());
        journal = original;
        store.put(&mut journal).unwrap();
        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE library_identity SET id=?1 WHERE singleton=1",
                [Uuid::new_v4().simple().to_string()],
            )
            .unwrap();
        assert!(store.psx_generation(&operation).is_err());
        assert!(library.all_installs().unwrap().is_empty());
    }

    #[test]
    fn generation_witness_refuses_oversized_serialization_without_committing() {
        use crate::operation::OperationStore;
        let temporary = tempfile::tempdir().unwrap();
        let (library, operation, journal, mut witness, _) =
            generation_witness_fixture(temporary.path());
        witness.contract = serde_json::Value::String("x".repeat(64 * 1024 * 1024));
        let store = OperationStore::new(library.clone());
        assert!(
            store
                .commit_psx_generation(&journal, &witness, &operation)
                .is_err()
        );
        let rows: i64 = library
            .connection()
            .unwrap()
            .query_row("SELECT count(*) FROM managed_psx_generation", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(rows, 0);
        assert!(store.get(&journal.id).unwrap().is_some());
        assert!(library.all_installs().unwrap().is_empty());
    }

    #[test]
    fn generation_witness_refuses_phase_or_closure_drift_during_verification() {
        use crate::operation::{LifecyclePhase, OperationStore};
        let temporary = tempfile::tempdir().unwrap();
        let (library, operation, mut journal, witness, _) =
            generation_witness_fixture(temporary.path());
        let store = OperationStore::new(library.clone());
        store
            .commit_psx_generation(&journal, &witness, &operation)
            .unwrap();
        let original = journal.clone();
        assert!(
            store
                .psx_generation_before_fence(&operation, || {
                    journal.phase = LifecyclePhase::Prepared;
                    store.put(&mut journal)
                })
                .is_err()
        );
        journal = original;
        store.put(&mut journal).unwrap();
        assert!(
            store
                .psx_generation_before_fence(&operation, || {
                    journal.preparation_process_quiesced = Some(false);
                    store.put(&mut journal)
                })
                .is_err()
        );
        assert!(store.get(&journal.id).unwrap().is_some());
        assert!(library.all_installs().unwrap().is_empty());
    }

    #[test]
    fn generation_witness_roundtrip_keeps_private_preparing_without_installation() {
        use crate::operation::{LifecyclePhase, OperationStore};
        let temporary = tempfile::tempdir().unwrap();
        let (library, operation, journal, witness, _) =
            generation_witness_fixture(temporary.path());
        let store = OperationStore::new(library.clone());
        store
            .commit_psx_generation(&journal, &witness, &operation)
            .unwrap();
        let reopened = Library::open(library.root()).unwrap();
        crate::PortcoveService::new(reopened.clone()).unwrap();
        let continuation = crate::Installer::new(reopened.clone())
            .unwrap()
            .managed_install_continuation(operation.operation_id())
            .unwrap();
        assert_eq!(continuation.operation_id, journal.id);
        assert_eq!(continuation.port_id, journal.port_id);
        let retained = OperationStore::new(reopened.clone())
            .get(&journal.id)
            .unwrap()
            .unwrap();
        assert_eq!(retained.phase, LifecyclePhase::StagedPreparing);
        assert!(retained.install.is_none());
        assert!(reopened.all_installs().unwrap().is_empty());
        assert!(!journal.paths.final_path.unwrap().exists());
        assert!(
            !journal
                .paths
                .staging
                .unwrap()
                .join("payload/.portcove-managed.json")
                .exists()
        );
        assert!(
            store
                .commit_psx_generation(&retained, &witness, &operation)
                .is_err()
        );
    }

    #[test]
    fn generation_witness_refuses_uncertain_and_changed_journal_custody() {
        use crate::operation::{LifecyclePhase, OperationStore};
        let temporary = tempfile::tempdir().unwrap();
        let (library, operation, mut journal, witness, _) =
            generation_witness_fixture(temporary.path());
        let store = OperationStore::new(library);
        let positive = journal.clone();
        journal.preparation_process_quiesced = Some(false);
        store.put(&mut journal).unwrap();
        assert!(
            store
                .commit_psx_generation(&positive, &witness, &operation)
                .is_err()
        );
        assert!(store.psx_generation(&operation).is_err());
        journal.preparation_process_quiesced = Some(true);
        store.put(&mut journal).unwrap();
        store
            .commit_psx_generation(&journal, &witness, &operation)
            .unwrap();
        journal.phase = LifecyclePhase::Prepared;
        store.put(&mut journal).unwrap();
        assert!(store.psx_generation(&operation).is_err());
    }

    #[test]
    fn generation_witness_refuses_missing_or_changed_bytes_and_retains_failure() {
        use crate::operation::OperationStore;
        let temporary = tempfile::tempdir().unwrap();
        let (library, operation, journal, witness, _) =
            generation_witness_fixture(temporary.path());
        let store = OperationStore::new(library.clone());
        assert!(store.psx_generation(&operation).is_err());
        store
            .commit_psx_generation(&journal, &witness, &operation)
            .unwrap();
        library.connection().unwrap().execute(
            "UPDATE managed_psx_generation SET witness_json=witness_json || ' ' WHERE operation_id=?1",
            [operation.operation_id()],
        ).unwrap();
        assert!(store.psx_generation(&operation).is_err());
        assert!(store.get(operation.operation_id()).unwrap().is_some());
        assert!(
            journal
                .paths
                .staging
                .unwrap()
                .join("payload/generated.c")
                .is_file()
        );
        assert!(library.all_installs().unwrap().is_empty());
    }

    #[test]
    fn generation_witness_refuses_source_drift_and_cascades_only_with_owner() {
        use crate::operation::OperationStore;
        let temporary = tempfile::tempdir().unwrap();
        let (library, operation, journal, witness, preparation) =
            generation_witness_fixture(temporary.path());
        let store = OperationStore::new(library.clone());
        store
            .commit_psx_generation(&journal, &witness, &operation)
            .unwrap();
        fs::write(&preparation.source.path, "changed inert source").unwrap();
        assert!(store.psx_generation(&operation).is_err());
        assert!(store.get(operation.operation_id()).unwrap().is_some());
        store.remove(operation.operation_id()).unwrap();
        let rows: i64 = library
            .connection()
            .unwrap()
            .query_row("SELECT count(*) FROM managed_psx_generation", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(rows, 0);
        assert!(
            journal
                .paths
                .staging
                .unwrap()
                .join("payload/generated.c")
                .is_file()
        );
    }

    #[test]
    fn generated_stage_refuses_another_valid_source_before_compilation() {
        let root = tempfile::tempdir().unwrap();
        let original = preparation_input_fixture(root.path(), false);
        let other_root = tempfile::tempdir().unwrap();
        let other = preparation_input_fixture(other_root.path(), false);
        let payload = root.path().join("owned-payload");
        fs::create_dir(&payload).unwrap();
        fs::write(payload.join("generated.c"), "inert generated fixture").unwrap();
        let operation = OperationCoordinator::new("owned-generation", None);
        // Inert stage fixture, not native generation evidence.
        let generated = GeneratedInstall {
            tree: stage::GeneratedTree::capture(&payload, &operation, true).unwrap(),
            toolchain: stage::GeneratedTree::capture(&payload, &operation, true).unwrap(),
            normalized_disc: stage::GeneratedTree::capture(&payload, &operation, true).unwrap(),
            inputs: preparation_identity(&original).unwrap(),
            generation_arguments: vec!["inert fixture; not executed".into()],
            staged_bios: None,
        };
        let mut quiesced = true;
        let error =
            finish_generated_install(&payload, &other, &operation, &mut quiesced, generated)
                .unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Verification);
        assert!(error.message.contains("inputs changed"));
        assert!(quiesced);
        assert!(!payload.join("build-portcove").exists());
        assert!(!payload.join(".portcove-managed.json").exists());
        crate::adapter::verify_source_storage_identity(&original.source, "original").unwrap();
        crate::adapter::verify_source_storage_identity(&other.source, "other").unwrap();
    }

    #[test]
    fn managed_preparation_rejects_unbound_disc_paths_before_adapter_work() {
        let temporary = tempfile::tempdir().unwrap();
        let preparation = preparation_input_fixture(temporary.path(), true);
        let foreign = temporary.path().join("foreign-disc.chd");
        fs::write(&foreign, b"foreign inert bytes").unwrap();
        let mut reversed = preparation.source_paths.clone();
        reversed.reverse();
        for paths in [vec![foreign], Vec::new(), reversed] {
            let mut invalid = preparation.clone();
            invalid.source_paths = paths;
            assert_invalid_preparation_input(temporary.path(), &invalid, "source_paths");
        }
    }

    #[test]
    fn managed_preparation_rejects_unsafe_basename_before_adapter_work() {
        let temporary = tempfile::tempdir().unwrap();
        let preparation = preparation_input_fixture(temporary.path(), false);
        for basename in ["../outside", "nested/game", "nested\\game", "", "C:game"] {
            let mut invalid = preparation.clone();
            invalid.executable_basename = basename.into();
            assert_invalid_preparation_input(temporary.path(), &invalid, "executable_basename");
        }
    }

    #[test]
    fn managed_preparation_rejects_unsafe_runtime_path_before_adapter_work() {
        let temporary = tempfile::tempdir().unwrap();
        let mut preparation = preparation_input_fixture(temporary.path(), true);
        preparation.runtime_source_directory = Some("owned/discs".into());
        let configuration = PreparationConfiguration::from_preparation(&preparation).unwrap();
        assert_eq!(
            configuration.runtime_source_directory,
            preparation.runtime_source_directory.as_deref()
        );
        let unix_rooted = ["", "outside"].join("/");
        let windows_rooted = ["C:", "outside"].join("/");
        for path in [
            "../outside",
            unix_rooted.as_str(),
            windows_rooted.as_str(),
            "",
            "disc/../outside",
        ] {
            let mut invalid = preparation.clone();
            invalid.runtime_source_directory = Some(path.into());
            assert_invalid_preparation_input(
                temporary.path(),
                &invalid,
                "runtime_source_directory",
            );
        }
    }

    #[test]
    fn managed_preparation_rejects_single_disc_runtime_mode_before_adapter_work() {
        let temporary = tempfile::tempdir().unwrap();
        let mut preparation = preparation_input_fixture(temporary.path(), false);
        preparation.runtime_source_directory = Some("owned/discs".into());
        assert_invalid_preparation_input(
            temporary.path(),
            &preparation,
            "runtime_source_directory",
        );

        let directory = temporary.path().join("owned-one-disc");
        fs::create_dir(&directory).unwrap();
        fs::write(directory.join("disc-01.chd"), b"inert owned disc bytes").unwrap();
        let (sha256, size) = crate::adapter::source_storage_identity(&directory).unwrap();
        preparation.source.path = directory.clone();
        preparation.source.sha256 = sha256.clone();
        preparation.source.size = size;
        preparation.source.storage_sha256 = sha256;
        preparation.source.storage_size = size;
        preparation.source_paths = crate::adapter::psx_source_paths(&directory, 1).unwrap();
        assert_invalid_preparation_input(
            temporary.path(),
            &preparation,
            "runtime_source_directory",
        );
    }

    #[test]
    fn managed_preparation_valid_disc_inputs_reach_existing_package_check() {
        for multi_disc in [false, true] {
            let temporary = tempfile::tempdir().unwrap();
            let mut preparation = preparation_input_fixture(temporary.path(), multi_disc);
            for runtime in [None, Some(PathBuf::from("owned/discs"))] {
                if !multi_disc && runtime.is_some() {
                    continue;
                }
                preparation.runtime_source_directory = runtime;
                let (result, quiesced) = prepare_install(
                    temporary.path(),
                    &preparation,
                    &OperationCoordinator::new("owned-valid-input", None),
                );
                let error = result.unwrap_err();
                assert_eq!(error.code, crate::ErrorCode::Install);
                assert!(error.message.contains("fixed psxrecomp CLI contract"));
                assert!(quiesced);
            }
        }
    }

    #[test]
    fn managed_preparation_configuration_preserves_valid_inputs() {
        for multi_disc in [false, true] {
            let temporary = tempfile::tempdir().unwrap();
            let mut preparation = preparation_input_fixture(temporary.path(), multi_disc);
            for runtime in [None, Some(PathBuf::from("owned/discs"))] {
                if !multi_disc && runtime.is_some() {
                    continue;
                }
                preparation.runtime_source_directory = runtime;
                let configuration =
                    PreparationConfiguration::from_preparation(&preparation).unwrap();
                assert_eq!(configuration.primary_source, preparation.source_paths[0]);
                assert_eq!(configuration.source_paths, preparation.source_paths);
                assert_eq!(configuration.executable_basename, "owned-game");
                assert_eq!(
                    configuration.runtime_source_directory,
                    preparation.runtime_source_directory.as_deref()
                );
            }
        }
    }

    #[test]
    fn managed_preparation_cancellation_precedes_invalid_inputs_and_preserves_quiescence() {
        let temporary = tempfile::tempdir().unwrap();
        let mut preparation = preparation_input_fixture(temporary.path(), false);
        preparation.source_paths.clear();
        let service =
            crate::PortcoveService::new(Library::open(temporary.path().join("library")).unwrap())
                .unwrap();
        let (activity, operation) = service
            .begin_cancellable_activity(
                crate::ActivityOperation::Install,
                crate::ActivityTargetKind::Port,
                Some("sample"),
            )
            .unwrap();
        service.request_cancellation(&activity.id).unwrap();
        let staging = temporary.path().join("owned-staging");
        fs::create_dir(&staging).unwrap();
        fs::write(staging.join("preserve"), b"preserve private bytes").unwrap();
        let identity = crate::adapter::source_storage_identity(&preparation.source.path).unwrap();
        for previous in [true, false] {
            let mut quiesced = previous;
            let result = prepare_install_inner(&staging, &preparation, &operation, &mut quiesced);
            assert_eq!(result.unwrap_err().code, crate::ErrorCode::Cancelled);
            assert_eq!(quiesced, previous);
            assert_eq!(fs::read_dir(&staging).unwrap().count(), 1);
            assert_eq!(
                fs::read(staging.join("preserve")).unwrap(),
                b"preserve private bytes"
            );
            assert_eq!(
                crate::adapter::source_storage_identity(&preparation.source.path).unwrap(),
                identity
            );
        }
    }

    // Execute this repository's small native probe through the production
    // builder boundary. No upstream Python, compiler, game or source is run.
    fn run_builder_fixture(root: &Path, operation: &OperationCoordinator) -> Result<()> {
        let toolchain = root.join("owned-toolchain");
        let python = if toolchain.join(".portcove-toolchain.json").is_file() {
            toolchain_python(&toolchain).unwrap()
        } else {
            let native = tempfile::tempdir().unwrap();
            let program = crate::test_fixture::build_probe(native.path());
            toolchain_fixture(&toolchain, Some(&program))
        };
        run_cli(
            &python,
            Path::new("--owned-builder-fixture"),
            root,
            &toolchain,
            [],
            operation,
            &mut true,
        )
    }

    fn assert_builder_cancellation(phase: &str) {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("owned-build");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("owned-builder-mode"), phase).unwrap();
        let native = tempfile::tempdir().unwrap();
        let program = crate::test_fixture::build_probe(native.path());
        toolchain_fixture(&root.join("owned-toolchain"), Some(&program));
        let player_source = temporary.path().join("player-source");
        fs::write(&player_source, b"unchanged external source").unwrap();
        let service =
            crate::PortcoveService::new(Library::open(temporary.path().join("library")).unwrap())
                .unwrap();
        let (activity, operation) = service
            .begin_cancellable_activity(
                crate::ActivityOperation::Install,
                crate::ActivityTargetKind::Library,
                None,
            )
            .unwrap();
        let observer = crate::PortcoveService::new(service.library().clone()).unwrap();
        let id = activity.id.clone();
        let ready = root.join("owned-builder-ready");
        let request = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(6);
            while !ready.is_file() {
                assert!(Instant::now() < deadline, "owned builder did not start");
                thread::sleep(Duration::from_millis(5));
            }
            observer.request_cancellation(&id).unwrap();
        });
        let started = Instant::now();
        let result = run_builder_fixture(&root, &operation);
        let elapsed = started.elapsed();
        request.join().unwrap();
        assert_eq!(
            fs::read(&player_source).unwrap(),
            b"unchanged external source"
        );
        assert!(
            operation.checkpoint().is_err(),
            "real cancellation was accepted"
        );
        println!("phase={phase} elapsed={elapsed:?} result={result:?}");
        let result = service.finish_activity(activity, result);
        assert_eq!(result.unwrap_err().code, crate::ErrorCode::Cancelled);
        assert!(
            elapsed < Duration::from_secs(2),
            "builder ignored cancellation"
        );
        assert!(!root.join("owned-builder-completed").exists());
    }

    #[test]
    fn managed_builder_generation_observes_active_cancellation() {
        assert_builder_cancellation("generation");
    }

    #[test]
    fn managed_builder_rebuild_observes_active_cancellation() {
        assert_builder_cancellation("rebuild");
    }

    #[test]
    fn managed_builder_preserves_success_and_nonzero_failure() {
        let temporary = tempfile::tempdir().unwrap();
        let operation = OperationCoordinator::new("owned-builder", None);
        fs::write(temporary.path().join("owned-builder-mode"), "success").unwrap();
        run_builder_fixture(temporary.path(), &operation).unwrap();
        fs::write(temporary.path().join("owned-builder-mode"), "failure").unwrap();
        let error = run_builder_fixture(temporary.path(), &operation).unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Install);
        assert!(error.message.contains("23"));
        assert!(error.details["output_tail"].contains("owned builder failure detail"));
        assert_eq!(error.details["output_truncated"], "false");
    }

    #[test]
    fn managed_builder_pre_spawn_cancellation_preserves_prior_uncertainty() {
        let temporary = tempfile::tempdir().unwrap();
        let service =
            crate::PortcoveService::new(Library::open(temporary.path().join("library")).unwrap())
                .unwrap();
        let (activity, operation) = service
            .begin_cancellable_activity(
                crate::ActivityOperation::Install,
                crate::ActivityTargetKind::Port,
                Some("sample"),
            )
            .unwrap();
        service.request_cancellation(&activity.id).unwrap();
        for previous in [true, false] {
            let mut quiesced = previous;
            let result = run_cli(
                &std::env::current_exe().unwrap(),
                Path::new("--exact"),
                temporary.path(),
                temporary.path(),
                [],
                &operation,
                &mut quiesced,
            );
            assert_eq!(result.unwrap_err().code, crate::ErrorCode::Cancelled);
            assert_eq!(quiesced, previous);
            assert!(!temporary.path().join("owned-builder-ready").exists());
        }
    }

    #[test]
    fn managed_builder_bounded_output_keeps_both_streams_and_status() {
        let temporary = tempfile::tempdir().unwrap();
        fs::write(temporary.path().join("owned-builder-mode"), "flood-failure").unwrap();
        let error = run_builder_fixture(
            temporary.path(),
            &OperationCoordinator::new("owned-builder", None),
        )
        .unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Install);
        assert!(error.message.contains("23"));
        assert!(error.details["output_tail"].contains("owned stderr after verbose stdout"));
        assert!(error.details["output_tail"].len() <= 64 * 1024);
    }

    #[test]
    fn managed_builder_reports_capture_and_error_detail_truncation() {
        let temporary = tempfile::tempdir().unwrap();
        let operation = OperationCoordinator::new("owned-builder", None);
        for mode in ["same-stream-flood", "clip-failure"] {
            fs::write(temporary.path().join("owned-builder-mode"), mode).unwrap();
            let error = run_builder_fixture(temporary.path(), &operation).unwrap_err();
            assert_eq!(error.code, crate::ErrorCode::Install);
            assert!(error.message.contains("23"));
            assert!(error.details["output_tail"].len() <= 64 * 1024);
            if mode == "same-stream-flood" {
                assert!(!error.details["output_tail"].contains("owned late stdout failure"));
            }
            assert_eq!(
                error.details.get("output_truncated").map(String::as_str),
                Some("true"),
                "{mode}"
            );
        }
    }

    #[test]
    fn managed_builder_workspace_survives_worker_error_and_unwind() {
        let staging = tempfile::tempdir().unwrap();
        let root = staging.path().join("payload");
        fs::create_dir(&root).unwrap();
        let workspace = retained_source_workspace(&root).unwrap();
        fs::write(workspace.join("owned-input"), b"retain across error").unwrap();
        let result = run_cli(
            Path::new("missing-owned-builder"),
            Path::new("fixed-cli"),
            &root,
            &root,
            [],
            &OperationCoordinator::new("owned-builder", None),
            &mut true,
        );
        assert_eq!(result.unwrap_err().code, crate::ErrorCode::Verification);
        assert_eq!(
            fs::read(workspace.join("owned-input")).unwrap(),
            b"retain across error"
        );
        let panic = std::panic::catch_unwind(|| {
            let owned = retained_source_workspace(&root).unwrap();
            fs::write(owned.join("owned-panic-input"), b"retain on unwind").unwrap();
            panic!("owned worker unwind");
        });
        assert!(panic.is_err());
        let retained = fs::read_dir(staging.path())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .any(|entry| entry.path().join("owned-panic-input").is_file());
        assert!(retained);
    }

    #[test]
    fn managed_chd_materialization_preserves_prior_quiescence_and_nonzero_status() {
        let native = tempfile::tempdir().unwrap();
        let program = crate::test_fixture::build_probe(native.path());
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("owned-disc.chd");
        fs::write(&source, b"unchanged owned CHD fixture").unwrap();
        let operation = OperationCoordinator::new("owned-chd", None);
        for previous in [true, false] {
            let destination = root.path().join(format!("success-{previous}"));
            let mut quiesced = previous;
            let cue = materialize_managed_disc(
                &source,
                &destination,
                Some(&program),
                &operation,
                &mut quiesced,
            )
            .unwrap();
            assert!(cue.is_file());
            assert_eq!(quiesced, previous && cfg!(windows));
        }
        fs::write(source.with_extension("conversion-mode"), "failure").unwrap();
        let destination = root.path().join("failed-output");
        let mut quiesced = true;
        let error = materialize_managed_disc(
            &source,
            &destination,
            Some(&program),
            &operation,
            &mut quiesced,
        )
        .unwrap_err();
        assert_eq!(error.code, crate::PortcoveError::source("fixture").code);
        assert_eq!(error.details["exit_code"], "29");
        assert_eq!(quiesced, cfg!(windows));
        assert!(
            destination.join("disc.cue").is_file(),
            "partial work remains retained"
        );
        assert_eq!(fs::read(source).unwrap(), b"unchanged owned CHD fixture");
    }

    #[test]
    fn managed_chd_materialization_observes_active_cancellation_and_stops_descendants() {
        let native = tempfile::tempdir().unwrap();
        let program = crate::test_fixture::build_probe(native.path());
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("owned-disc.chd");
        fs::write(&source, b"unchanged owned CHD fixture").unwrap();
        fs::write(source.with_extension("conversion-mode"), "wait").unwrap();
        let destination = root.path().join("private-disc");
        let service =
            crate::PortcoveService::new(Library::open(root.path().join("library")).unwrap())
                .unwrap();
        let (activity, operation) = service
            .begin_cancellable_activity(
                crate::ActivityOperation::Install,
                crate::ActivityTargetKind::Library,
                None,
            )
            .unwrap();
        let observer = crate::PortcoveService::new(service.library().clone()).unwrap();
        let id = activity.id.clone();
        let ready = source.with_extension("conversion-ready");
        let private = destination.clone();
        let started = Instant::now();
        let request = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(6);
            while !ready.is_file() {
                assert!(
                    Instant::now() < deadline,
                    "owned CHD helper did not reach waiting boundary"
                );
                thread::sleep(Duration::from_millis(10));
            }
            assert!(private.join("disc.cue").is_file());
            assert!(private.join("disc1.bin").is_file());
            eprintln!("owned CHD ready at {:?}", started.elapsed());
            observer.request_cancellation(&id).unwrap();
            eprintln!("owned cancellation acknowledged at {:?}", started.elapsed());
            Instant::now()
        });
        let mut quiesced = true;
        let result = materialize_managed_disc(
            &source,
            &destination,
            Some(&program),
            &operation,
            &mut quiesced,
        );
        let returned = Instant::now();
        let acknowledged = request.join().unwrap();
        eprintln!(
            "owned helper returned at {:?}",
            returned.duration_since(started)
        );
        assert_eq!(
            result.as_ref().unwrap_err().code,
            crate::ErrorCode::Cancelled
        );
        // Bound stopping after the durable request is acknowledged, separately
        // from the service's catalog/SQLite admission work before that ACK.
        assert!(returned.saturating_duration_since(acknowledged) < Duration::from_secs(3));
        assert_eq!(quiesced, cfg!(windows));
        assert!(destination.join("disc.cue").is_file());
        assert!(destination.join("disc1.bin").is_file());
        assert_eq!(fs::read(&source).unwrap(), b"unchanged owned CHD fixture");
        assert_eq!(
            service.finish_activity(activity, result).unwrap_err().code,
            crate::ErrorCode::Cancelled
        );
        // Positive owned-tree exit is checked by the supervisor tests above;
        // these retained partial inputs must not receive additional writes.
        thread::sleep(Duration::from_millis(1200));
        assert!(!source.with_extension("orphan-output").exists());
        assert!(
            !source
                .with_extension("conversion-unexpected-completion")
                .exists()
        );
    }

    #[test]
    fn managed_chd_materialization_pre_spawn_cancellation_preserves_prior_uncertainty() {
        let root = tempfile::tempdir().unwrap();
        let service =
            crate::PortcoveService::new(Library::open(root.path().join("library")).unwrap())
                .unwrap();
        let (activity, operation) = service
            .begin_cancellable_activity(
                crate::ActivityOperation::Install,
                crate::ActivityTargetKind::Library,
                None,
            )
            .unwrap();
        service.request_cancellation(&activity.id).unwrap();
        let destination = root.path().join("must-not-create");
        for previous in [true, false] {
            let mut quiesced = previous;
            let error = materialize_managed_disc(
                &root.path().join("must-not-read.chd"),
                &destination,
                Some(Path::new("must-not-launch")),
                &operation,
                &mut quiesced,
            )
            .unwrap_err();
            assert_eq!(error.code, crate::ErrorCode::Cancelled);
            assert_eq!(quiesced, previous);
            assert!(!destination.exists());
        }
    }

    #[test]
    fn managed_builder_stops_ordinary_native_descendants() {
        let native = tempfile::tempdir().unwrap();
        let program = crate::test_fixture::build_probe(native.path());
        let root = tempfile::tempdir().unwrap();
        let marker = root.path().join("owned-descendant-output");
        let python = toolchain_fixture(root.path(), Some(&program));
        let mut quiesced = true;
        run_cli(
            &python,
            Path::new("--setup-tree"),
            root.path(),
            root.path(),
            [marker.display().to_string(), "exit".into()],
            &OperationCoordinator::new("owned-builder", None),
            &mut quiesced,
        )
        .unwrap();
        assert_eq!(quiesced, cfg!(windows));
        thread::sleep(Duration::from_millis(1200));
        assert!(!marker.exists());
    }

    #[cfg(unix)]
    #[test]
    fn managed_builder_escaped_descendant_retains_workspace_without_proof() {
        let native = tempfile::tempdir().unwrap();
        let program = crate::test_fixture::build_probe(native.path());
        let staging = tempfile::tempdir().unwrap();
        let workspace = retained_source_workspace(&staging.path().join("payload")).unwrap();
        let marker = workspace.join("owned-escaped-output");
        let ready = workspace.join("owned-escaped-ready");
        let mut quiesced = true;
        let python = toolchain_fixture(&workspace, Some(&program));
        run_cli(
            &python,
            Path::new("--setup-tree-escape"),
            &workspace,
            &workspace,
            [marker.display().to_string(), ready.display().to_string()],
            &OperationCoordinator::new("owned-builder", None),
            &mut quiesced,
        )
        .unwrap();
        assert!(!quiesced);
        assert!(workspace.is_dir());
        thread::sleep(Duration::from_millis(1200));
        assert!(marker.is_file());
    }

    fn toolchain_fixture(root: &Path, program: Option<&Path>) -> PathBuf {
        let platform = Platform::current().unwrap();
        let artifact = toolchain_artifact(platform).unwrap();
        let python = if cfg!(windows) {
            root.join("python").join("python.exe")
        } else {
            root.join("python").join("bin").join("python3")
        };
        let cmake = platform_executable(&root.join("bin"), "cmake");
        let ninja = platform_executable(&root.join("bin"), "ninja");
        for (path, bytes) in [
            (&python, b"python".as_slice()),
            (&cmake, b"cmake".as_slice()),
            (&ninja, b"ninja".as_slice()),
            (&root.join("retcomm-toolchain.json"), b"metadata".as_slice()),
        ] {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, bytes).unwrap();
        }
        if let Some(program) = program {
            for path in [&python, &cmake, &ninja] {
                fs::copy(program, path).unwrap();
            }
        }
        let marker = ToolchainMarker {
            schema_version: 2,
            version: TOOLCHAIN_VERSION.into(),
            platform,
            asset_name: artifact.name.into(),
            sha256: artifact.sha256.into(),
            critical_files: toolchain_file_identities(root, platform).unwrap(),
        };
        fs::write(
            root.join(".portcove-toolchain.json"),
            serde_json::to_vec_pretty(&marker).unwrap(),
        )
        .unwrap();
        python
    }

    #[test]
    fn toolchain_marker_is_bound_to_current_critical_file_bytes() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path();
        toolchain_fixture(root, None);
        let platform = Platform::current().unwrap();
        let artifact = toolchain_artifact(platform).unwrap();
        assert!(validate_toolchain(root, platform, artifact).unwrap());

        fs::write(
            platform_executable(&root.join("bin"), "cmake"),
            b"tampered cmake",
        )
        .unwrap();

        assert!(!validate_toolchain(root, platform, artifact).unwrap());
    }

    #[test]
    fn managed_builder_preflight_bounds_growth_and_preserves_hash_cancellation() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path();
        let python = toolchain_fixture(root, None);
        let platform = Platform::current().unwrap();
        let artifact = toolchain_artifact(platform).unwrap();
        // Grow a declared file after the marker: refusal must precede hashing/spawn.
        fs::OpenOptions::new()
            .write(true)
            .open(&python)
            .unwrap()
            .set_len(16 * 1024 * 1024)
            .unwrap();
        let mut checkpoints = 0;
        assert!(
            !validate_toolchain_with_checkpoint(root, platform, artifact, || {
                checkpoints += 1;
                Ok(())
            })
            .unwrap()
        );
        assert!(checkpoints <= 4);
        assert!(!root.join(".portcove-builder-environment").exists());
        toolchain_fixture(root, None);
        let service =
            crate::PortcoveService::new(Library::open(root.join("cancellation-library")).unwrap())
                .unwrap();
        let (activity, operation) = service
            .begin_cancellable_activity(
                crate::ActivityOperation::Install,
                crate::ActivityTargetKind::Library,
                None,
            )
            .unwrap();
        let mut checkpoints = 0;
        let error = validate_toolchain_with_checkpoint(root, platform, artifact, || {
            checkpoints += 1;
            if checkpoints == 3 {
                service.request_cancellation(&activity.id).unwrap();
                // Let the existing 50ms cancellation polling interval expire.
                thread::sleep(Duration::from_millis(60));
            }
            operation.checkpoint()
        })
        .unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Cancelled);
        assert!(!root.join(".portcove-builder-environment").exists());
        fs::write(
            root.join(".portcove-toolchain.json"),
            vec![b' '; 64 * 1024 + 1],
        )
        .unwrap();
        assert_eq!(
            validate_toolchain(root, platform, artifact)
                .unwrap_err()
                .code,
            crate::ErrorCode::Verification
        );
    }

    #[cfg(unix)]
    #[test]
    fn managed_builder_preflight_refuses_aliased_tools_without_touching_foreign_bytes() {
        let temporary = tempfile::tempdir().unwrap();
        let foreign = temporary.path().join("foreign");
        toolchain_fixture(&foreign, None);
        let alias = temporary.path().join("alias");
        std::os::unix::fs::symlink(&foreign, &alias).unwrap();
        let platform = Platform::current().unwrap();
        let artifact = toolchain_artifact(platform).unwrap();
        assert!(validate_toolchain(&alias, platform, artifact).is_err());
        let owned = temporary.path().join("owned");
        toolchain_fixture(&owned, None);
        let owned_cmake = platform_executable(&owned.join("bin"), "cmake");
        let foreign_cmake = platform_executable(&foreign.join("bin"), "cmake");
        fs::remove_file(&owned_cmake).unwrap();
        std::os::unix::fs::symlink(&foreign_cmake, &owned_cmake).unwrap();
        assert!(validate_toolchain(&owned, platform, artifact).is_err());
        assert_eq!(fs::read(foreign_cmake).unwrap(), b"cmake");
        assert!(!foreign.join(".portcove-builder-environment").exists());
    }

    #[test]
    fn managed_builder_refuses_missing_or_changed_tools_before_spawn() {
        let native = tempfile::tempdir().unwrap();
        let program = crate::test_fixture::build_probe(native.path());
        for changed in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let python = toolchain_fixture(root.path(), Some(&program));
            let cmake = platform_executable(&root.path().join("bin"), "cmake");
            if changed {
                fs::write(&cmake, b"changed declared tool").unwrap();
            } else {
                fs::remove_file(&cmake).unwrap();
            }
            let marker = root.path().join("must-not-spawn");
            let mut quiesced = true;
            let error = run_cli(
                &python,
                Path::new("--grandchild"),
                root.path(),
                root.path(),
                [marker.display().to_string()],
                &OperationCoordinator::new("owned-builder-refusal", None),
                &mut quiesced,
            )
            .unwrap_err();
            assert_eq!(error.code, crate::ErrorCode::Verification);
            assert!(quiesced);
            assert!(!marker.exists());
            assert!(!root.path().join(".portcove-builder-environment").exists());
        }
    }

    #[test]
    fn managed_generation_uses_only_pinned_tools_and_private_profile_paths() {
        let native = tempfile::tempdir().unwrap();
        let program = crate::test_fixture::build_probe(native.path());
        let root = tempfile::tempdir().unwrap();
        let python = toolchain_fixture(root.path(), Some(&program));
        let arguments = generation_arguments(
            &root.path().join("game.toml"),
            root.path(),
            &root.path().join("disc.cue"),
            None,
        )
        .unwrap();
        let mut quiesced = true;
        run_cli(
            &python,
            Path::new("--psx-builder-contract"),
            root.path(),
            root.path(),
            arguments,
            &OperationCoordinator::new("owned-generation", None),
            &mut quiesced,
        )
        .unwrap();
        assert_eq!(
            fs::read(
                root.path()
                    .join(".portcove-builder-environment/home/builder-probe")
            )
            .unwrap(),
            b"private fixture write"
        );
        assert_eq!(
            fs::read(
                root.path()
                    .join(".portcove-builder-environment/temp/builder-probe")
            )
            .unwrap(),
            b"private fixture write"
        );
    }

    #[test]
    fn managed_rebuild_disables_optional_launchers_with_pinned_private_tools() {
        let native = tempfile::tempdir().unwrap();
        let program = crate::test_fixture::build_probe(native.path());
        let root = tempfile::tempdir().unwrap();
        let python = toolchain_fixture(root.path(), Some(&program));
        let arguments = rebuild_arguments(
            &root.path().join("game.toml"),
            root.path(),
            &root.path().join("build-portcove"),
            "owned-game",
        )
        .unwrap();
        let mut quiesced = true;
        run_cli(
            &python,
            Path::new("--psx-builder-contract"),
            root.path(),
            root.path(),
            arguments,
            &OperationCoordinator::new("owned-rebuild", None),
            &mut quiesced,
        )
        .unwrap();
        assert_eq!(
            fs::read(
                root.path()
                    .join(".portcove-builder-environment/home/builder-probe")
            )
            .unwrap(),
            b"private fixture write"
        );
    }

    #[test]
    fn pinned_toolchains_cover_every_platform() {
        for platform in [
            Platform::WindowsX86_64,
            Platform::LinuxX86_64,
            Platform::MacosX86_64,
            Platform::MacosAarch64,
        ] {
            let artifact = toolchain_artifact(platform).unwrap();
            assert_eq!(artifact.sha256.len(), 64);
            assert!(artifact.size > 1_000_000);
        }
    }

    #[test]
    fn runtime_config_replaces_upstream_disc_paths_with_verified_chds() {
        let temporary = tempfile::tempdir().unwrap();
        let config = temporary.path().join("game.toml");
        fs::write(
            &config,
            "[game]\nname = \"Example\"\ndiscs = [\n  \"/maintainer/disc1.cue\",\n  \"/maintainer/disc2.cue\",\n]\ndisc_serials = [\"ONE\", \"TWO\"]\n\n[runtime]\nwindow_title = \"Example\"\n",
        )
        .unwrap();
        let sources = [
            PathBuf::from(r"D:\ROMs\Example (Disc 1).chd"),
            PathBuf::from(r"D:\ROMs\Example (Disc 2).chd"),
        ];

        rewrite_game_discs(&config, &sources).unwrap();

        let body = fs::read_to_string(config).unwrap();
        assert!(body.contains(r#"    "D:\\ROMs\\Example (Disc 1).chd","#));
        assert!(body.contains(r#"    "D:\\ROMs\\Example (Disc 2).chd","#));
        assert!(!body.contains("/maintainer"));
        assert!(body.contains("disc_serials"));
        assert!(body.contains("[runtime]"));
    }

    #[test]
    fn runtime_config_is_seeded_when_an_upstream_build_omits_it() {
        let temporary = tempfile::tempdir().unwrap();
        let project = temporary.path().join("game.toml");
        let runtime = temporary.path().join("build").join("game.toml");
        fs::write(&project, "[game]\ndisc = \"maintainer.cue\"\n").unwrap();
        fs::create_dir_all(runtime.parent().unwrap()).unwrap();
        let sources = [PathBuf::from(r"D:\ROMs\Game.chd")];

        prepare_runtime_config(&project, &runtime, &sources).unwrap();

        let body = fs::read_to_string(runtime).unwrap();
        assert!(body.contains(r#"disc = "D:\\ROMs\\Game.chd""#));
        assert!(!body.contains("maintainer.cue"));
    }

    #[test]
    fn runtime_config_accepts_relative_immutable_cue_descriptors() {
        let temporary = tempfile::tempdir().unwrap();
        let config = temporary.path().join("game.toml");
        fs::write(
            &config,
            "[game]\ndiscs = [\n  \"maintainer-1.cue\",\n  \"maintainer-2.cue\",\n]\n",
        )
        .unwrap();
        let sources = [
            PathBuf::from("runtime-discs/disc-01.cue"),
            PathBuf::from("runtime-discs/disc-02.cue"),
        ];

        rewrite_game_discs(&config, &sources).unwrap();

        let body = fs::read_to_string(config).unwrap();
        assert!(body.contains(r#"    "runtime-discs/disc-01.cue","#));
        assert!(body.contains(r#"    "runtime-discs/disc-02.cue","#));
        assert!(!body.contains("maintainer"));
    }

    fn rewrite_config_fixture(body: &str, sources: &[&str]) -> String {
        let temporary = tempfile::tempdir().unwrap();
        let config = temporary.path().join("game.toml");
        fs::write(&config, body).unwrap();
        let sources = sources.iter().map(PathBuf::from).collect::<Vec<_>>();
        rewrite_game_discs(&config, &sources).unwrap();
        fs::read_to_string(config).unwrap()
    }

    #[test]
    fn runtime_config_rewrite_handles_brackets_inside_disc_strings() {
        let body = "[game]\ndiscs = [\n  'maintainer[Disc 1].cue',\n  \"maintainer[Disc 2].cue\",\n]\ndisc_serials = ['ONE', 'TWO']\n";
        let rewritten = rewrite_config_fixture(body, &["verified/one.cue", "verified/two.cue"]);
        assert_eq!(
            rewritten,
            "[game]\ndiscs = [\n    \"verified/one.cue\",\n    \"verified/two.cue\",\n]\ndisc_serials = ['ONE', 'TWO']\n"
        );
    }

    #[test]
    fn runtime_config_rewrite_preserves_array_comments_with_brackets() {
        let body = "[game]\ndiscs = [ # ordered discs ]\n  # first ]\n  'old-one.cue', # first disc\n  \"old#two].cue\", # second disc\n] # accepted list\nname = 'Example'\n";
        let rewritten = rewrite_config_fixture(body, &["verified/one.cue", "verified/two.cue"]);
        assert_eq!(
            rewritten,
            "[game]\ndiscs = [\n    \"verified/one.cue\",\n    \"verified/two.cue\",\n    # ordered discs ]\n    # first ]\n    # first disc\n    # second disc\n] # accepted list\nname = 'Example'\n"
        );
    }

    #[test]
    fn runtime_config_rewrite_accepts_compact_and_quoted_keys() {
        for assignment in [
            "discs=['old.cue']",
            "'discs' = ['old.cue']",
            "\"di\\u0073cs\"\t=\t['old.cue']",
        ] {
            let body = format!("[game]\n{assignment} # preserved\n[runtime]\ndisc='unrelated.cue'");
            let rewritten = rewrite_config_fixture(&body, &["verified/one.cue"]);
            assert!(!rewritten.contains("old.cue"));
            assert!(rewritten.contains("\"verified/one.cue\" # preserved\n"));
            assert!(rewritten.ends_with("[runtime]\ndisc='unrelated.cue'"));
            assert!(!rewritten.contains("discs"));
        }
    }

    #[test]
    fn runtime_config_rewrite_accepts_commented_game_header() {
        let body = "[game] # selected project\nname = 'Example'\ndisc='old.cue'\n";
        assert_eq!(
            rewrite_config_fixture(body, &["verified/one.cue"]),
            "[game] # selected project\nname = 'Example'\ndisc=\"verified/one.cue\"\n"
        );
    }

    #[test]
    fn runtime_config_rewrite_accepts_spaced_and_quoted_game_headers() {
        for header in [
            " [ game ]\t",
            "['game']",
            r#"["g\u0061me"]"#,
            r#"["g\U00000061me"]"#,
        ] {
            let body = format!("{header}\ndisc = 'old.cue'\n");
            assert_eq!(
                rewrite_config_fixture(&body, &["verified/one.cue"]),
                format!("{header}\ndisc = \"verified/one.cue\"\n")
            );
        }
    }

    #[test]
    fn runtime_config_rewrite_preserves_utf8_crlf_and_unrelated_multiline_values() {
        let prefix = "# 日本語\r\n[metadata]\r\nnotes = '''\r\n[game]\r\ndisc='text, not a field'\r\n'''\r\nquoted = \"\"\"escaped \\\" ] # text\r\n[game]\r\n\"\"\"\r\n[game.extra]\r\ndisc = 'unrelated.cue'\r\n[ game ] # retained header\r\n";
        let suffix =
            " # retained field comment\r\nname = '例'\r\n[runtime]\r\nwindow_title = '原文'";
        let body = format!("{prefix}disc='old.cue'{suffix}");
        assert_eq!(
            rewrite_config_fixture(&body, &["verified/日本語.cue"]),
            format!("{prefix}disc=\"verified/日本語.cue\"{suffix}")
        );
    }

    #[test]
    fn runtime_config_rewrite_preserves_comments_when_changing_disc_count() {
        let body =
            "[game]\ndiscs = [ # list comment\n 'old.cue', # member comment\n] # closing comment\n";
        assert_eq!(
            rewrite_config_fixture(body, &["verified/one.cue"]),
            "[game]\ndisc = \"verified/one.cue\"\n# list comment\n# member comment\n # closing comment\n"
        );
        assert_eq!(
            rewrite_config_fixture(
                "[game]\ndisc = 'old.cue' # single comment",
                &["one.cue", "two.cue"]
            ),
            "[game]\ndiscs = [\n    \"one.cue\",\n    \"two.cue\",\n] # single comment"
        );
    }

    #[test]
    fn runtime_config_rewrite_rejects_ambiguous_or_unbounded_fields_without_writing() {
        let temporary = tempfile::tempdir().unwrap();
        let config = temporary.path().join("game.toml");
        for body in [
            "[runtime]\ndisc='old.cue'\n",
            "[game]\ndisc='one.cue'\ndiscs=['two.cue']\n",
            "[game]\ndisc='one.cue'\n[ 'game' ]\ndisc='two.cue'\n",
            "[game]\ndisc = 42\n",
            "[game]\ndiscs = ['one.cue' 'two.cue']\n",
            "[game]\ndiscs = [\n 'unterminated.cue\n]\n",
            "[game]\ndiscs = [\n 'one.cue'\n",
            "[game]\ndisc.extra = 'not a disc field'\n",
        ] {
            fs::write(&config, body).unwrap();
            assert!(
                rewrite_game_discs(&config, &[PathBuf::from("verified.cue")]).is_err(),
                "{body}"
            );
            assert_eq!(fs::read_to_string(&config).unwrap(), body);
        }
        let body = "[game]\ndisc='old.cue'\n";
        fs::write(&config, body).unwrap();
        assert!(rewrite_game_discs(&config, &[]).is_err());
        assert_eq!(fs::read_to_string(config).unwrap(), body);
    }

    #[test]
    fn runtime_config_rewrite_seeds_missing_fields_and_is_idempotent() {
        for body in [
            "[game]",
            "[game] # EOF",
            "[game]\r\nname='例'\r\n",
            "[game]\nname='Example'\n[runtime]\ndisc='unrelated'",
        ] {
            let temporary = tempfile::tempdir().unwrap();
            let config = temporary.path().join("game.toml");
            fs::write(&config, body).unwrap();
            let sources = [PathBuf::from("verified.cue")];
            rewrite_game_discs(&config, &sources).unwrap();
            let once = fs::read_to_string(&config).unwrap();
            assert!(once.contains("disc = \"verified.cue\""));
            assert_eq!(once.ends_with('\n'), body.ends_with('\n'));
            rewrite_game_discs(&config, &sources).unwrap();
            assert_eq!(fs::read_to_string(config).unwrap(), once);
        }
    }

    #[test]
    fn runtime_config_rewrite_handles_multiline_string_delimiters_and_line_folding() {
        let body = "[metadata]\nnotes = ''''quoted' [game] disc='not a field' ''''\nfolded = \"\"\"one\\\n  two \"\"\"\n[game]\ndiscs = [\n '''old[one].cue''',\n \"\"\"old\\\n two].cue\"\"\",\n]\n";
        let rewritten = rewrite_config_fixture(body, &["verified/one.cue", "verified/two.cue"]);
        assert_eq!(
            rewritten,
            "[metadata]\nnotes = ''''quoted' [game] disc='not a field' ''''\nfolded = \"\"\"one\\\n  two \"\"\"\n[game]\ndiscs = [\n    \"verified/one.cue\",\n    \"verified/two.cue\",\n]\n"
        );
    }

    #[test]
    fn runtime_config_rewrite_escapes_del_and_keeps_comment_eof() {
        assert_eq!(
            rewrite_config_fixture("[game]\ndisc='old.cue'", &["disc\u{7f}é.cue"]),
            "[game]\ndisc=\"disc\\u007Fé.cue\""
        );
        assert_eq!(
            rewrite_config_fixture("[game]\ndiscs=[ # retained\n 'old.cue'\n]", &["new.cue"]),
            "[game]\ndisc=\"new.cue\"\n# retained"
        );
    }
}
