use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use crate::{
    AdapterKind, ArtifactIdentity, BundledRuntime, InstallRecord, Library, OperationCoordinator,
    OperationEvent, Platform, PortDefinition, PortcoveError, PsxManagedPreparation, ReleaseAsset,
    ResolvedRelease, Result, RuntimeIdentity, RuntimeOrigin,
    adapter::{hash_file, walk_files},
    archive::{
        extract_archive_with_checkpoint, validate_download_progress, validate_download_size,
    },
    operation::{
        LifecycleFaultInjector, LifecycleFaultPoint, LifecycleOperation, LifecycleOperationKind,
        LifecyclePhase, NoLifecycleFaults, OperationStore,
    },
};
use futures_util::StreamExt;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

#[derive(Debug, Clone)]
pub struct InstallRequest {
    pub port_id: String,
    pub release: ResolvedRelease,
    pub output_root: PathBuf,
    pub activate: bool,
    pub managed: Option<PsxManagedPreparation>,
    pub qualification: InstallQualification,
}

/// Cache eligibility belongs to the exact qualified platform, not the grant alone.
struct AssetAcquisition<'a> {
    scope: &'a crate::DefinitionAcquisitionScope,
    curated: bool,
}

#[derive(Debug, Clone)]
pub struct InstallQualification {
    strict_staged_source: bool,
    runtime_data_policy: Option<crate::RuntimeDataPolicy>,
    managed_shared_preferences: Option<crate::PreparedSharedPreferencesContract>,
    shared_preferences: Option<crate::managed_shared_preferences::Acceptance>,
    native_build_recipe: Option<crate::CartridgeBuildRecipe>,
    acquisition: Option<crate::ScopedResolvedRelease>,
    retained_contract: Option<crate::installed_contract::InstalledContract>,
    platform: Platform,
    executable_hints: Vec<String>,
    runtime_subdirectory: Option<String>,
    persistent_paths: Vec<String>,
    persistent_file_patterns: Vec<crate::PersistentFilePattern>,
    runtime_mutable_paths: Vec<String>,
    runtime_mutable_file_patterns: Vec<crate::PersistentFilePattern>,
    persistence_at_install_root: bool,
    runtime: Option<BundledRuntime>,
    runtime_origin: RuntimeOrigin,
    generated_metadata: Vec<String>,
    critical_paths: Vec<String>,
    protected_paths: Vec<String>,
}

impl InstallQualification {
    pub(crate) fn with_shared_preferences(
        mut self,
        accepted: Option<crate::managed_shared_preferences::Acceptance>,
        root: &Path,
    ) -> Result<Self> {
        let contract = self.retained_contract.as_ref().ok_or_else(|| {
            PortcoveError::verification("shared preference acceptance requires a retained catalog")
        })?;
        let catalog = contract.catalog(contract.port_id())?;
        crate::managed_shared_preferences::require_acceptance(
            catalog.port(contract.port_id())?,
            accepted.as_ref(),
            root,
        )?;
        self.shared_preferences = accepted;
        Ok(self)
    }
    fn require_runtime_creation(&self) -> Result<()> {
        if self.native_build_recipe.is_some() {
            return Err(crate::cartridge_build::retired_creation());
        }
        Ok(())
    }
    pub(crate) fn with_cartridge_build_source(
        self,
        _source: Option<&crate::SourceRecord>,
    ) -> Result<Self> {
        self.require_runtime_creation()?;
        Ok(self)
    }
    pub(crate) fn with_acquisition_resolution(
        mut self,
        resolution: crate::ScopedResolvedRelease,
    ) -> Result<Self> {
        if let Some(scope) = &resolution.scope {
            scope.require_current()?;
            let contract = self.retained_contract.as_ref().ok_or_else(|| {
                PortcoveError::state("scoped resolution requires its retained contract")
            })?;
            let catalog = contract.catalog(&scope.stable_id)?;
            if catalog.definition_selection(&scope.stable_id) != scope.identity.as_ref() {
                return Err(PortcoveError::verification(
                    "resolved acquisition belongs to another retained definition",
                ));
            }
            scope.require_port(catalog.port(&scope.stable_id)?)?;
            self.acquisition = Some(resolution);
        }
        Ok(self)
    }

    /// Capture the catalog and referenced source contracts before publication.
    pub fn from_catalog(
        catalog: &crate::Catalog,
        port_id: &str,
        platform: Platform,
    ) -> Result<Self> {
        let mut qualification = Self::from_port(catalog.port(port_id)?, platform)?;
        qualification.retained_contract = Some(
            crate::installed_contract::InstalledContract::capture(catalog, port_id)?,
        );
        Ok(qualification)
    }

    /// Build a verification projection. New manifests require `from_catalog`.
    pub fn from_port(port: &PortDefinition, platform: Platform) -> Result<Self> {
        crate::runtime::validate(port)?;
        for pattern in port
            .persistent_file_patterns
            .iter()
            .chain(&port.runtime_mutable_file_patterns)
        {
            pattern.validate()?;
        }
        let executable_hints = port
            .executable_hints
            .get(&platform)
            .cloned()
            .unwrap_or_default();
        if executable_hints.is_empty() {
            return Err(PortcoveError::verification(format!(
                "{} has no declared executable for {platform:?}",
                port.name
            )));
        }
        Ok(Self {
            strict_staged_source: matches!(
                port.adapter,
                AdapterKind::StagedSourcePortable | AdapterKind::NativePortable
            ),
            runtime_data_policy: port.runtime_data_policy,
            managed_shared_preferences: port.managed_shared_preferences,
            shared_preferences: None,
            native_build_recipe: port.release.managed_build.get(&platform).copied(),
            acquisition: None,
            retained_contract: None,
            platform,
            executable_hints,
            runtime_subdirectory: port.runtime_subdirectory.clone(),
            persistent_paths: port.persistent_paths.clone(),
            persistent_file_patterns: port.persistent_file_patterns.clone(),
            runtime_mutable_paths: port.runtime_mutable_paths.clone(),
            runtime_mutable_file_patterns: port.runtime_mutable_file_patterns.clone(),
            persistence_at_install_root: port.adapter == AdapterKind::N64RecompPortable
                || port.launch_from_install_root,
            runtime: port.bundled_runtime.get(&platform).cloned(),
            runtime_origin: RuntimeOrigin::VerifiedDownload,
            generated_metadata: crate::adapter::generated_metadata(port)?,
            critical_paths: (port.adapter == AdapterKind::PsxRecompManaged
                && port.runtime_source_materialization
                    == Some(crate::RuntimeSourceMaterialization::PsxRawSet))
            .then(|| port.runtime_source_filename.clone())
            .flatten()
            .into_iter()
            .chain(
                port.release
                    .managed_build
                    .get(&platform)
                    .map(|recipe| recipe.original_filename().into()),
            )
            .chain(
                port.release
                    .managed_build
                    .contains_key(&platform)
                    .then_some(crate::cartridge_build::RECEIPT.into()),
            )
            .collect(),
            protected_paths: port
                .runtime_source_set
                .iter()
                .map(|source| source.destination.clone())
                .collect(),
        })
    }

    pub(crate) fn persistence_root(&self, root: &Path, selected: &Path) -> PathBuf {
        if self.persistence_at_install_root {
            root.to_path_buf()
        } else {
            selected.parent().unwrap_or(root).to_path_buf()
        }
    }

    fn runtime_root(&self, root: &Path, selected: &Path) -> PathBuf {
        self.runtime_subdirectory.as_ref().map_or_else(
            || self.persistence_root(root, selected),
            |directory| root.join(directory),
        )
    }

    fn generated_metadata_paths(&self, install: &InstallRecord) -> Result<Vec<String>> {
        let working = self.runtime_root(
            &install.path,
            &install.path.join(&install.selected_executable),
        );
        self.generated_metadata
            .iter()
            .map(|relative| manifest_relative(&install.path, &working.join(relative)))
            .collect()
    }

    fn current_mutable_paths(&self, install: &InstallRecord) -> Result<Vec<String>> {
        let working = self.runtime_root(
            &install.path,
            &install.path.join(&install.selected_executable),
        );
        let persistent = self.persistence_root(
            &install.path,
            &install.path.join(&install.selected_executable),
        );
        self.runtime_mutable_paths
            .iter()
            .map(|relative| working.join(relative))
            .chain(
                self.persistent_paths
                    .iter()
                    .map(|relative| persistent.join(relative)),
            )
            .map(|path| manifest_relative(&install.path, &path))
            .collect()
    }

    fn file_patterns(&self, root: &Path, selected: &Path) -> Result<Vec<ManifestFilePattern>> {
        let directory = |working: PathBuf| -> Result<Option<String>> {
            if working == root {
                Ok(None)
            } else {
                Ok(Some(manifest_relative(root, &working)?))
            }
        };
        let persistent_directory = directory(self.persistence_root(root, selected))?;
        let runtime_directory = directory(self.runtime_root(root, selected))?;
        let mut patterns = self
            .persistent_file_patterns
            .iter()
            .map(|pattern| ManifestFilePattern {
                directory: persistent_directory.clone(),
                pattern: pattern.clone(),
            })
            .collect::<Vec<_>>();
        for pattern in &self.runtime_mutable_file_patterns {
            if patterns.iter().any(|existing| {
                existing.directory == runtime_directory && existing.pattern.overlaps(pattern)
            }) {
                return Err(PortcoveError::usage(
                    "persistent and nonpersistent runtime file patterns overlap",
                ));
            }
            patterns.push(ManifestFilePattern {
                directory: runtime_directory.clone(),
                pattern: pattern.clone(),
            });
        }
        Ok(patterns)
    }

    #[cfg(test)]
    pub(crate) fn with_test_runtime_url(mut self, url: String) -> Self {
        self.runtime.as_mut().expect("test runtime").asset.url = url;
        self
    }

    #[cfg(test)]
    pub(crate) fn test(executable: &str) -> Self {
        Self::test_for_port("sample", executable)
    }

    #[cfg(test)]
    fn test_for_port(port_id: &str, executable: &str) -> Self {
        let mut port = crate::Catalog::embedded()
            .unwrap()
            .port("zelda64-recomp")
            .unwrap()
            .clone();
        port.id = port_id.into();
        port.source_profile = None;
        port.presentation = None;
        port.source_environment = None;
        port.runtime_source_filename = None;
        port.runtime_source_materialization = None;
        port.runtime_source_hashes.clear();
        port.runtime_source_set.clear();
        port.user_data_environment = None;
        port.launch_environment.clear();
        port.launch_arguments.clear();
        port.persistent_paths.clear();
        port.persistent_file_patterns.clear();
        port.runtime_mutable_paths.clear();
        port.runtime_mutable_file_patterns.clear();
        port.portable_marker = false;
        port.platforms = vec![
            Platform::WindowsX86_64,
            Platform::LinuxX86_64,
            Platform::MacosX86_64,
            Platform::MacosAarch64,
        ];
        port.automated_tested_platforms.clear();
        port.manually_validated_platforms.clear();
        port.executable_hints = port
            .platforms
            .iter()
            .map(|platform| (*platform, vec![executable.into()]))
            .collect();
        crate::test_fixture::retained_qualification(&port, Platform::WindowsX86_64).unwrap()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct VerificationReport {
    pub install_id: String,
    pub checked_files: u64,
    pub valid: bool,
    pub failures: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct InstallManifest {
    schema_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    retained_contract: Option<crate::installed_contract::InstalledContract>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    shared_preferences: Option<crate::managed_shared_preferences::Acceptance>,
    #[serde(default)]
    platform: Option<Platform>,
    install_id: String,
    port_id: String,
    version: String,
    artifact: ArtifactIdentity,
    #[serde(default)]
    runtime: Option<RuntimeIdentity>,
    #[serde(default)]
    runtime_root: Option<String>,
    selected_executable: String,
    mutable_paths: Vec<String>,
    #[serde(default)]
    mutable_file_patterns: Vec<ManifestFilePattern>,
    files: Vec<ManifestFile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct ManifestFilePattern {
    directory: Option<String>,
    pattern: crate::PersistentFilePattern,
}

impl ManifestFilePattern {
    fn matches(&self, relative: &str) -> bool {
        let (directory, name) = relative
            .rsplit_once('/')
            .map_or((None, relative), |(directory, name)| {
                (Some(directory), name)
            });
        directory == self.directory.as_deref() && self.pattern.matches(name)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ManifestFile {
    path: String,
    size: u64,
    sha256: String,
    critical: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    executable: bool,
}

const fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Clone)]
pub struct Installer {
    library: Library,
    client: reqwest::Client,
    network_bounds: (Duration, Duration),
    faults: Arc<dyn LifecycleFaultInjector>,
    #[cfg(test)]
    archive_worker_test_hook: Option<ArchiveWorkerTestHook>,
    #[cfg(test)]
    cache_worker_test_hook: Option<crate::curated_cache::CacheWorkerTestHook>,
}

#[cfg(test)]
#[derive(Clone)]
pub(crate) struct ArchiveWorkerTestHook {
    pub checkpoint: Arc<dyn Fn() -> Result<()> + Send + Sync>,
    pub finished: Arc<std::sync::atomic::AtomicBool>,
    pub pending_joins: Arc<std::sync::atomic::AtomicUsize>,
}

struct InstallLifecycle {
    destination: std::path::PathBuf,
    operation_root: std::path::PathBuf,
    store: OperationStore,
    record: LifecycleOperation,
}

// This existing nullable field tracks joined managed preparation workers and
// CVLoD blob mutations. None remains the legacy/non-managed Install contract.
async fn run_managed_install_worker(
    lifecycle: &mut InstallLifecycle,
    operation: &OperationCoordinator,
    worker: impl FnOnce(OperationCoordinator) -> (Result<()>, bool) + Send + 'static,
) -> Result<()> {
    lifecycle.record.preparation_process_quiesced = Some(false);
    lifecycle.store.put(&mut lifecycle.record)?;
    let checkpoint = operation.clone();
    // A mutation worker must be joined, including cancellation. A join failure
    // or unwind leaves both the in-memory and durable proof false.
    let (result, quiesced) = tokio::task::spawn_blocking(move || worker(checkpoint))
        .await
        .map_err(|error| PortcoveError::install(error.to_string()))?;
    let mut completed = lifecycle.record.clone();
    completed.preparation_process_quiesced = Some(quiesced);
    lifecycle.store.put(&mut completed)?;
    lifecycle.record = completed;
    result
}

// Artifact transfers can legitimately run for hours, so they have no total
// request deadline. Connection and no-progress intervals remain bounded.
const DOWNLOAD_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const DOWNLOAD_READ_IDLE_TIMEOUT: Duration = Duration::from_secs(30);

fn download_client(
    connect_timeout: Duration,
    read_idle_timeout: Duration,
) -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(concat!("Portcove/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(connect_timeout)
        .read_timeout(read_idle_timeout)
        .build()
        .map_err(|error| PortcoveError::network(error.to_string()))
}

impl Installer {
    pub fn new(library: Library) -> Result<Self> {
        let client = download_client(DOWNLOAD_CONNECT_TIMEOUT, DOWNLOAD_READ_IDLE_TIMEOUT)?;
        Ok(Self {
            library,
            client,
            network_bounds: (DOWNLOAD_CONNECT_TIMEOUT, DOWNLOAD_READ_IDLE_TIMEOUT),
            faults: Arc::new(NoLifecycleFaults),
            #[cfg(test)]
            archive_worker_test_hook: None,
            #[cfg(test)]
            cache_worker_test_hook: None,
        })
    }

    #[cfg(test)]
    fn with_network_bounds(
        library: Library,
        connect_timeout: Duration,
        read_idle_timeout: Duration,
    ) -> Result<Self> {
        Ok(Self {
            library,
            client: download_client(connect_timeout, read_idle_timeout)?,
            network_bounds: (connect_timeout, read_idle_timeout),
            faults: Arc::new(NoLifecycleFaults),
            archive_worker_test_hook: None,
            cache_worker_test_hook: None,
        })
    }

    #[cfg(test)]
    pub(crate) fn with_archive_worker_test_hook(mut self, hook: ArchiveWorkerTestHook) -> Self {
        self.archive_worker_test_hook = Some(hook);
        self
    }

    #[cfg(test)]
    pub(crate) fn with_cache_worker_test_hook(
        mut self,
        hook: crate::curated_cache::CacheWorkerTestHook,
    ) -> Self {
        self.cache_worker_test_hook = Some(hook);
        self
    }

    pub(crate) fn with_faults(
        library: Library,
        faults: Arc<dyn LifecycleFaultInjector>,
    ) -> Result<Self> {
        let mut installer = Self::new(library)?;
        installer.faults = faults;
        Ok(installer)
    }

    pub async fn install<F>(
        &self,
        request: InstallRequest,
        operation: &OperationCoordinator,
        mut emit: F,
    ) -> Result<InstallRecord>
    where
        F: FnMut(OperationEvent),
    {
        self.require_acquisition(&request)?;
        request.qualification.require_runtime_creation()?;
        let mut storage_key = artifact_storage_key(&request.release.asset.sha256)?;
        if let Some(runtime) = &request.qualification.runtime {
            storage_key = hex::encode(Sha256::digest(serde_json::to_vec(&(
                "Portcove composite installation v1",
                storage_key,
                runtime.identity(),
            ))?));
        }
        let required_bytes = request.release.asset.size.saturating_add(
            request
                .qualification
                .runtime
                .as_ref()
                .map_or(0, |runtime| runtime.asset.size),
        );
        let prepared_root = crate::output_root::prepare_for_install(
            &self.library,
            &request.port_id,
            &request.output_root,
            operation.operation_id(),
            required_bytes,
        )?;
        let destination = prepared_root.root.join(&storage_key);
        if request.qualification.managed_shared_preferences.is_some() {
            let contract = request
                .qualification
                .retained_contract
                .as_ref()
                .ok_or_else(|| {
                    PortcoveError::verification("shared scope has no retained catalog")
                })?;
            let catalog = contract.catalog(&request.port_id)?;
            crate::managed_shared_preferences::require_acceptance(
                catalog.port(&request.port_id)?,
                request.qualification.shared_preferences.as_ref(),
                &destination,
            )?;
        }
        if destination.exists() {
            return Err(PortcoveError::conflict(format!(
                "version {} already exists for {}",
                request.release.version, request.port_id
            )));
        }
        let operation_root = prepared_root.operation_root;
        let mut record = LifecycleOperation::new(
            operation.operation_id(),
            LifecycleOperationKind::Install,
            &request.port_id,
        );
        record.paths.staging = Some(operation_root.clone());
        record.paths.final_path = Some(destination.clone());
        record.activate = request.activate;
        let store = OperationStore::new(self.library.clone());
        store.put(&mut record)?;
        let mut lifecycle = InstallLifecycle {
            destination,
            operation_root,
            store,
            record,
        };
        let mut result = self
            .install_inner(request, operation, &mut lifecycle, &mut emit)
            .await;
        if let Err(error) = &mut result {
            if lifecycle.record.phase == LifecyclePhase::Preparing {
                if error.code == crate::ErrorCode::Cancelled {
                    if let Err(cleanup) = crate::cancellation::discard_private_install(
                        &self.library,
                        &lifecycle.record,
                    ) {
                        let mut refusal = PortcoveError::new(crate::ErrorCode::Cancelled,
                            "Publication was cancelled; private preparation cleanup requires review")
                            .detail("operation_id", lifecycle.record.id).detail("cleanup_error", cleanup.message);
                        // Retain bounded native proof diagnostics without changing cleanup authority.
                        refusal
                            .details
                            .extend(crate::tool_process::copy_proof_details(error));
                        return Err(refusal);
                    }
                    return result;
                }
                if let Err(cleanup) = crate::cancellation::discard_private_install_with_faults(
                    &self.library,
                    &lifecycle.record,
                    self.faults.as_ref(),
                ) {
                    lifecycle.record.phase = LifecyclePhase::CleanupPending;
                    lifecycle.record.install = None;
                    lifecycle.record.last_error = Some(format!(
                        "{}; private preparation cleanup failed: {}",
                        error.message, cleanup.message
                    ));
                    if let Err(persist) = lifecycle.store.put(&mut lifecycle.record) {
                        let mut refusal = PortcoveError::state(
                            "install failed and private cleanup state could not be retained",
                        )
                        .detail("operation_id", &lifecycle.record.id)
                        .detail("install_error", &error.message)
                        .detail("cleanup_error", cleanup.message)
                        .detail("persistence_error", persist.message);
                        refusal
                            .details
                            .extend(crate::tool_process::copy_proof_details(error));
                        return Err(refusal);
                    }
                    error
                        .details
                        .insert("operation_id".into(), lifecycle.record.id.clone());
                    error
                        .details
                        .insert("cleanup_state".into(), "recovery_required".into());
                    error
                        .details
                        .insert("cleanup_error".into(), cleanup.message);
                }
            } else {
                lifecycle.record.last_error = Some(error.message.clone());
                let _ = lifecycle.store.put(&mut lifecycle.record);
            }
        }
        result
    }

    fn require_acquisition(
        &self,
        request: &InstallRequest,
    ) -> Result<Option<crate::DefinitionAcquisitionScope>> {
        if request.qualification.runtime_data_policy.is_some()
            && request.qualification.retained_contract.is_none()
        {
            return Err(PortcoveError::verification(
                "version-local credential policy requires its retained catalog before acquisition",
            ));
        }
        let catalog = match &request.qualification.retained_contract {
            Some(contract) => contract.catalog(&request.port_id)?,
            None => self.library.load_catalog()?.0,
        };
        if catalog.port(&request.port_id)?.managed_initialization
            == Some(crate::ManagedInitialization::TfeDarkForcesPortableV1)
        {
            if request.qualification.retained_contract.is_none() {
                return Err(PortcoveError::verification(
                    "managed initialization requires its retained catalog before acquisition",
                ));
            }
            crate::managed_tfe::require_artifact(
                catalog.port(&request.port_id)?,
                &request.release.version,
                &ArtifactIdentity {
                    asset_name: request.release.asset.name.clone(),
                    sha256: request.release.asset.sha256.clone(),
                    size: request.release.asset.size,
                },
                Some(request.qualification.platform),
            )?;
        }
        if request.qualification.managed_shared_preferences.is_some()
            || request
                .release
                .asset
                .sha256
                .eq_ignore_ascii_case(crate::managed_shared_preferences::SHA)
        {
            let port = catalog.port(&request.port_id)?;
            if request.qualification.retained_contract.is_none()
                || request.qualification.managed_shared_preferences
                    != port.managed_shared_preferences
            {
                return Err(PortcoveError::verification(
                    "shared preferences require the matching retained qualification before acquisition",
                ));
            }
            crate::managed_shared_preferences::require_artifact(
                port,
                &request.release.version,
                &ArtifactIdentity {
                    asset_name: request.release.asset.name.clone(),
                    sha256: request.release.asset.sha256.clone(),
                    size: request.release.asset.size,
                },
                Some(request.qualification.platform),
            )?;
            let destination = request
                .output_root
                .join(artifact_storage_key(&request.release.asset.sha256)?);
            crate::managed_shared_preferences::require_acceptance(
                port,
                request.qualification.shared_preferences.as_ref(),
                &destination,
            )?;
        }
        if request.qualification.runtime_data_policy.is_some()
            || crate::runtime_data_policy::known_artifact(&request.release.asset.sha256)
        {
            if request.qualification.retained_contract.is_none()
                || request.qualification.runtime_data_policy
                    != catalog.port(&request.port_id)?.runtime_data_policy
            {
                return Err(PortcoveError::verification(
                    "credential-safe acquisition requires the matching retained qualification",
                ));
            }
            crate::runtime_data_policy::require_artifact(
                catalog.port(&request.port_id)?,
                &request.release.version,
                &ArtifactIdentity {
                    asset_name: request.release.asset.name.clone(),
                    sha256: request.release.asset.sha256.clone(),
                    size: request.release.asset.size,
                },
                Some(request.qualification.platform),
            )?;
        }
        let current = crate::definition_repository::publisher_policy::acquisition_scope(
            &self.library,
            &catalog,
            &request.port_id,
        )?;
        match (current, &request.qualification.acquisition) {
            (None, None) => Ok(None),
            (Some(current), Some(resolution)) => {
                let scope = resolution.scope.as_ref().ok_or_else(|| {
                    PortcoveError::state("managed resolution lost its acquisition proof")
                })?;
                if !scope.same_authorization(&current)
                    || resolution.release.asset != request.release.asset
                    || resolution.release.version != request.release.version
                    || resolution.release.channel != request.release.channel
                {
                    return Err(PortcoveError::conflict(
                        "installation acquisition proof changed",
                    ));
                }
                scope.require_current()?;
                scope.require_asset_url(&request.release.asset.url)?;
                if let Some(record) = catalog
                    .port(&request.port_id)?
                    .release
                    .curated
                    .get(&request.qualification.platform)
                {
                    crate::definition_repository::publisher_policy::require_curated_artifact_operation(
                        &self.library.connection()?, scope.repository_id, record,
                        crate::definition_repository::publisher_policy::CuratedArtifactOperation::Acquisition,
                    )?;
                }
                Ok(Some(scope.clone()))
            }
            _ => Err(PortcoveError::unsupported(
                "installation requires an exact qualified acquisition resolution",
            )),
        }
    }

    async fn refresh_curated_acquisition(
        &self,
        request: &InstallRequest,
        scope: Option<&crate::DefinitionAcquisitionScope>,
        operation: &OperationCoordinator,
    ) -> Result<()> {
        use crate::ReleaseProvider;
        let Some(scope) = scope.filter(|scope| scope.curated_checks == Some(1)) else {
            return Ok(());
        };
        let contract = request
            .qualification
            .retained_contract
            .as_ref()
            .ok_or_else(|| {
                PortcoveError::state("curated acquisition lost its retained definition")
            })?;
        let catalog = contract.catalog(&request.port_id)?;
        let port = catalog.port(&request.port_id)?;
        let provider = crate::GithubReleaseProvider::for_acquisition_scope(scope)?;
        let refreshed = operation
            .interruptible(provider.resolve_scoped(
                port,
                request.release.channel,
                request.qualification.platform,
                Some(scope),
            ))
            .await?;
        if refreshed.release.asset != request.release.asset
            || refreshed.release.version != request.release.version
            || refreshed.release.channel != request.release.channel
        {
            return Err(PortcoveError::conflict(
                "curated acquisition resolution changed",
            ));
        }
        scope.require_current()?;
        Ok(())
    }

    async fn install_inner<F>(
        &self,
        request: InstallRequest,
        operation: &OperationCoordinator,
        lifecycle: &mut InstallLifecycle,
        emit: &mut F,
    ) -> Result<InstallRecord>
    where
        F: FnMut(OperationEvent),
    {
        request.qualification.require_runtime_creation()?;
        let scope = self.require_acquisition(&request)?;
        // A retained resolution is provenance, not reusable upstream freshness.
        // Re-observe mutable identities before touching the artifact bytes.
        self.refresh_curated_acquisition(&request, scope.as_ref(), operation)
            .await?;
        let acquisition = match scope.as_ref() {
            Some(scope) => {
                let contract = request
                    .qualification
                    .retained_contract
                    .as_ref()
                    .ok_or_else(|| {
                        PortcoveError::state("scoped acquisition lost its retained definition")
                    })?;
                let catalog = contract.catalog(&request.port_id)?;
                let curated = scope.curated_checks == Some(1)
                    && catalog
                        .port(&request.port_id)?
                        .release
                        .curated
                        .contains_key(&request.qualification.platform);
                Some(AssetAcquisition { scope, curated })
            }
            None => None,
        };
        let operation_id = operation.operation_id().to_owned();
        let payload_root = lifecycle.operation_root.join("payload");
        fs::create_dir_all(&payload_root)?;
        let artifact = self
            .prepare_asset(
                &request.release.asset,
                &lifecycle.operation_root.join("artifact.download"),
                &payload_root,
                operation,
                emit,
                acquisition,
            )
            .await?;
        if request.qualification.managed_shared_preferences.is_some() {
            let catalog = request
                .qualification
                .retained_contract
                .as_ref()
                .ok_or_else(|| {
                    PortcoveError::verification("shared scope lost its retained catalog")
                })?
                .catalog(&request.port_id)?;
            crate::managed_shared_preferences::prepare_owned_saves(
                catalog.port(&request.port_id)?,
                &payload_root,
            )?;
        }
        normalize_standalone_appimage(&payload_root, &artifact, &request.qualification)?;
        if let Some(runtime) = &request.qualification.runtime {
            let unpacked = lifecycle.operation_root.join("runtime");
            fs::create_dir_all(&unpacked)?;
            self.prepare_asset(
                &runtime.asset,
                &lifecycle.operation_root.join("runtime.download"),
                &unpacked,
                operation,
                emit,
                None,
            )
            .await?;
            let source = unpacked.join(&runtime.archive_root);
            crate::runtime::require_executable(&source, runtime, request.qualification.platform)?;
            let selected = resolve_declared_executable(&payload_root, &request.qualification)?;
            let destination = request
                .qualification
                .runtime_root(&payload_root, &selected)
                .join(&runtime.target_directory);
            crate::runtime::require_vacant(
                destination.parent().expect("runtime has parent"),
                &runtime.target_directory,
            )?;
            crate::durability::rename_noreplace(&source, &destination)?;
            operation.checkpoint()?;
        }
        if let Some(preparation) = request.managed.clone() {
            emit(operation.message("info", "Preparing and compiling PlayStation game data"));
            let managed_root = payload_root.clone();
            run_managed_install_worker(lifecycle, operation, move |checkpoint| {
                crate::psx::prepare_install(&managed_root, &preparation, &checkpoint)
            })
            .await?;
            operation.checkpoint()?;
        }
        let (manifest_sha256, selected_executable, runtime) = write_manifest(
            &operation_id,
            &request.port_id,
            &request.release.version,
            &artifact,
            &request.qualification,
            &payload_root,
        )?;
        let install = InstallRecord {
            id: operation_id,
            port_id: request.port_id.clone(),
            version: request.release.version.clone(),
            path: lifecycle.destination.clone(),
            channel: request.release.channel,
            installed_at: Library::now(),
            verified: true,
            staged: !request.activate,
            artifact,
            runtime,
            manifest_sha256,
            selected_executable,
        };
        lifecycle.record.install = Some(install.clone());
        self.faults
            .check(LifecycleFaultPoint::InstallReadyToPublish)?;
        operation.begin_publication()?;
        lifecycle.record.phase = LifecyclePhase::Prepared;
        lifecycle.store.put(&mut lifecycle.record)?;
        self.faults.check(LifecycleFaultPoint::InstallPrepared)?;
        self.require_acquisition(&request)?;
        fs::create_dir_all(
            lifecycle
                .destination
                .parent()
                .expect("version directory has a parent"),
        )?;
        if lifecycle.destination.exists() {
            return Err(PortcoveError::conflict(format!(
                "version {} was installed by another operation",
                request.release.version
            )));
        } else {
            crate::durability::rename_noreplace(&payload_root, &lifecycle.destination)?;
        }
        lifecycle.record.phase = LifecyclePhase::PayloadPublished;
        lifecycle.store.put(&mut lifecycle.record)?;
        self.faults.check(LifecycleFaultPoint::InstallPublished)?;
        self.require_acquisition(&request)?;
        self.library.register_install(&install, request.activate)?;
        lifecycle.record.phase = LifecyclePhase::MetadataCommitted;
        lifecycle.store.put(&mut lifecycle.record)?;
        self.faults
            .check(LifecycleFaultPoint::InstallMetadataCommitted)?;
        let cleanup = (|| -> Result<()> {
            #[cfg(windows)]
            if lifecycle.record.port_id == "cvlod-recomp"
                && lifecycle.record.preparation_process_quiesced.is_some()
            {
                crate::legacy_cartridge_cleanup::unlink_published_private_wininet_junction(
                    &self.library,
                    &lifecycle.record,
                    &lifecycle.operation_root,
                )?;
            }
            fs::remove_dir_all(&lifecycle.operation_root)?;
            Ok(())
        })();
        if let Err(error) = cleanup {
            lifecycle.record.phase = LifecyclePhase::CleanupPending;
            lifecycle.record.last_error = Some(error.to_string());
            lifecycle.store.put(&mut lifecycle.record)?;
            return Ok(install);
        }
        lifecycle.store.remove(&lifecycle.record.id)?;
        Ok(install)
    }

    async fn prepare_asset<F>(
        &self,
        asset: &ReleaseAsset,
        download_path: &Path,
        payload_root: &Path,
        operation: &OperationCoordinator,
        emit: &mut F,
        acquisition: Option<AssetAcquisition<'_>>,
    ) -> Result<ArtifactIdentity>
    where
        F: FnMut(OperationEvent),
    {
        let scope = acquisition.as_ref().map(|acquisition| acquisition.scope);
        let curated = acquisition
            .as_ref()
            .filter(|acquisition| acquisition.curated)
            .map(|acquisition| acquisition.scope);
        let cache_worker = curated.map(|scope| {
            #[allow(unused_mut)]
            let mut worker = crate::curated_cache::CacheWorker::new(scope, asset, operation);
            #[cfg(test)]
            {
                worker.hook = self.cache_worker_test_hook.clone();
            }
            worker
        });
        let restored = match cache_worker.as_ref() {
            Some(worker) => worker.restore(download_path).await?,
            None => false,
        };
        if !restored {
            match scope {
                Some(scope) => {
                    self.download_scoped(asset, download_path, operation, emit, Some(scope))
                        .await?
                }
                None => self.download(asset, download_path, operation, emit).await?,
            }
        }
        let (actual_hash, actual_size) = if curated.is_some() {
            let identity = crate::adapter::hash_file_bounded_with_checkpoint(
                download_path,
                asset.size,
                || operation.checkpoint(),
            )?;
            validate_download_size(identity.1, asset.size)?;
            identity
        } else {
            crate::adapter::hash_file_with_checkpoint(download_path, || operation.checkpoint())?
        };
        if !actual_hash.eq_ignore_ascii_case(&asset.sha256) {
            return Err(PortcoveError::verification(
                "downloaded asset failed SHA-256 verification",
            )
            .detail("asset", &asset.name)
            .detail("expected", &asset.sha256)
            .detail("actual", actual_hash));
        }
        emit(operation.message("info", format!("Download checksum matches: {}", asset.name)));
        let asset_name = asset.name.clone();
        let extraction_path = download_path.to_path_buf();
        let extraction_root = payload_root.to_path_buf();
        let expected_size = asset.size;
        let extraction_operation = operation.clone();
        #[cfg(test)]
        let archive_worker_test_hook = self.archive_worker_test_hook.clone();
        let worker = tokio::task::spawn_blocking(move || {
            let result = extract_asset(
                &extraction_path,
                &extraction_root,
                &asset_name,
                expected_size,
                &|| {
                    #[cfg(test)]
                    if let Some(hook) = &archive_worker_test_hook {
                        (hook.checkpoint)()?;
                    }
                    extraction_operation.checkpoint()
                },
            );
            #[cfg(test)]
            if let Some(hook) = &archive_worker_test_hook {
                hook.finished
                    .store(true, std::sync::atomic::Ordering::SeqCst);
            }
            result
        });
        #[cfg(test)]
        let worker = {
            let mut worker = worker;
            let hook = self.archive_worker_test_hook.as_ref();
            std::future::poll_fn(move |context| {
                let observed = std::future::Future::poll(std::pin::Pin::new(&mut worker), context);
                if observed.is_pending()
                    && let Some(hook) = hook
                {
                    hook.pending_joins
                        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                }
                observed
            })
        };
        worker
            .await
            .map_err(|error| PortcoveError::install(error.to_string()))??;
        operation.checkpoint()?;
        if let Some(worker) = cache_worker {
            let retained = worker.retain(download_path).await?;
            emit(operation.message(
                "info",
                if retained {
                    "Verified curated artifact cache retained"
                } else {
                    "Verified artifact acquired; cache capacity unavailable"
                },
            ));
        }
        Ok(ArtifactIdentity {
            asset_name: asset.name.clone(),
            sha256: actual_hash.to_ascii_lowercase(),
            size: actual_size,
        })
    }

    async fn download<F>(
        &self,
        asset: &ReleaseAsset,
        destination: &Path,
        operation: &OperationCoordinator,
        emit: &mut F,
    ) -> Result<()>
    where
        F: FnMut(OperationEvent),
    {
        self.download_scoped(asset, destination, operation, emit, None)
            .await
    }

    async fn download_scoped<F>(
        &self,
        asset: &ReleaseAsset,
        destination: &Path,
        operation: &OperationCoordinator,
        emit: &mut F,
        scope: Option<&crate::DefinitionAcquisitionScope>,
    ) -> Result<()>
    where
        F: FnMut(OperationEvent),
    {
        let client = match scope {
            Some(scope) => {
                scope.require_current()?;
                scope.require_asset_url(&asset.url)?;
                reqwest::Client::builder()
                    .user_agent(concat!("Portcove/", env!("CARGO_PKG_VERSION")))
                    .connect_timeout(self.network_bounds.0)
                    .read_timeout(self.network_bounds.1)
                    .redirect(scope.redirect_policy())
                    .build()
                    .map_err(|error| PortcoveError::network(error.to_string()))?
            }
            None => self.client.clone(),
        };
        Self::download_with_client(&client, asset, destination, operation, emit).await
    }

    /// Shared bounded byte transfer; callers supply a provider-constrained
    /// client and still own checksum verification and publication policy.
    pub(crate) async fn download_with_client<F>(
        client: &reqwest::Client,
        asset: &ReleaseAsset,
        destination: &Path,
        operation: &OperationCoordinator,
        emit: &mut F,
    ) -> Result<()>
    where
        F: FnMut(OperationEvent),
    {
        validate_download_progress(0, asset.size)?;
        let response = operation
            .interruptible(async {
                client
                    .get(&asset.url)
                    .send()
                    .await
                    .map_err(|error| PortcoveError::network(error.to_string()))?
                    .error_for_status()
                    .map_err(|error| PortcoveError::network(error.to_string()))
            })
            .await?;
        let total = response
            .content_length()
            .or(Some(asset.size))
            .filter(|value| *value > 0);
        let mut stream = response.bytes_stream();
        let mut file = tokio::fs::File::create(destination).await?;
        let mut completed = 0_u64;
        let mut reported = 0_u64;
        while let Some(chunk) = operation
            .interruptible(async { Ok(stream.next().await) })
            .await?
        {
            let chunk = chunk.map_err(|error| PortcoveError::network(error.to_string()))?;
            file.write_all(&chunk).await?;
            completed += chunk.len() as u64;
            validate_download_progress(completed, asset.size)?;
            if total.is_some_and(|total| completed == total)
                || completed.saturating_sub(reported) >= 1024 * 1024
            {
                emit(operation.progress("download", completed, total));
                reported = completed;
            }
        }
        if completed != reported {
            emit(operation.progress("download", completed, total));
        }
        file.flush().await?;
        validate_download_size(completed, asset.size)?;
        Ok(())
    }

    pub fn verify(&self, install: &InstallRecord) -> Result<VerificationReport> {
        self.verify_with_metadata(install, &[], &[], false)
    }

    /// Read small immutable metadata only through the registered manifest identity.
    pub(crate) fn read_verified_member(
        &self,
        install: &InstallRecord,
        relative: &str,
        limit: u64,
    ) -> Result<Vec<u8>> {
        let member = immutable_member(install, relative)?;
        let bytes =
            crate::path::read_bounded_regular(&manifest_member(&install.path, relative)?, limit)?;
        if bytes.len() as u64 != member.size
            || crate::signed_catalog::digest(&bytes) != member.sha256
        {
            return Err(PortcoveError::verification(
                "prepared metadata differs from its admitted manifest",
            ));
        }
        Ok(bytes)
    }

    pub(crate) fn verify_recorded_member(
        &self,
        install: &InstallRecord,
        path: &Path,
    ) -> Result<()> {
        let relative = manifest_relative(&install.path, path)?;
        let member = immutable_member(install, &relative)?;
        let path = manifest_member(&install.path, &relative)?;
        if !is_regular_file_without_symlink(&path) {
            return Err(PortcoveError::verification(
                "prepared output is not a regular file",
            ));
        }
        let (sha256, size) = hash_file(&path)?;
        if size != member.size || sha256 != member.sha256 {
            return Err(PortcoveError::verification(
                "prepared output differs from its admitted manifest",
            ));
        }
        Ok(())
    }

    pub(crate) fn verify_managed(
        &self,
        install: &InstallRecord,
        qualification: &InstallQualification,
    ) -> Result<VerificationReport> {
        self.verify_with_metadata(
            install,
            &qualification.generated_metadata_paths(install)?,
            &qualification.current_mutable_paths(install)?,
            qualification.strict_staged_source,
        )
    }

    pub(crate) fn permits_additive_mutability(
        &self,
        install: &InstallRecord,
        retained: &InstallQualification,
        candidate: &InstallQualification,
    ) -> Result<bool> {
        let manifest = verified_manifest(install)?;
        let old = retained.current_mutable_paths(install)?;
        for path in candidate.current_mutable_paths(install)? {
            if old.contains(&path) {
                continue;
            }
            let prefix = format!("{path}/");
            if manifest
                .files
                .iter()
                .any(|file| file.path == path || file.path.starts_with(&prefix))
                || is_executable_companion_name(Path::new(&path), candidate.platform)
            {
                return Ok(false);
            }
        }
        Ok(true)
    }

    pub(crate) fn require_mutability_file_shapes(
        &self,
        install: &InstallRecord,
        qualification: &InstallQualification,
        persistent: &[&str],
        runtime: &[&str],
    ) -> Result<()> {
        let selected = install.path.join(&install.selected_executable);
        let persistent_root = qualification.persistence_root(&install.path, &selected);
        let runtime_root = qualification.runtime_root(&install.path, &selected);
        for relative in persistent {
            require_optional_mutable_file(&manifest_member(&persistent_root, relative)?)?;
            require_optional_mutable_file(&manifest_member(
                &self.library.user_dir(&install.port_id),
                relative,
            )?)?;
        }
        for relative in runtime {
            require_optional_mutable_file(&manifest_member(&runtime_root, relative)?)?;
        }
        Ok(())
    }

    fn verify_with_metadata(
        &self,
        install: &InstallRecord,
        generated_metadata: &[String],
        current_mutable_paths: &[String],
        staged_fallback: bool,
    ) -> Result<VerificationReport> {
        let manifest = verified_manifest(install)?;
        let strict_staged = full_immutable_integrity(&manifest, install, staged_fallback)?;
        let staged_candidates = if strict_staged {
            Some(staged_install_files(&install.path)?)
        } else {
            None
        };
        let mut failures = Vec::new();
        failures.extend(mutable_file_pattern_failures(&install.path, &manifest)?);
        for file in &manifest.files {
            let candidate = manifest_member(&install.path, &file.path)?;
            if strict_staged {
                require_staged_path(&install.path, &candidate)?;
            }
            if !is_regular_file_without_symlink(&candidate) {
                failures.push(format!("missing: {}", file.path));
                continue;
            }
            let (sha256, size) = hash_file(&candidate)?;
            if size != file.size || sha256 != file.sha256 {
                failures.push(format!("changed: {}", file.path));
            } else if manifest.schema_version >= 5
                && crate::permissions::executable_intent(&candidate)? != file.executable
            {
                failures.push(format!("permissions changed: {}", file.path));
            }
        }
        let expected = manifest
            .files
            .iter()
            .map(|file| file.path.as_str())
            .collect::<std::collections::BTreeSet<_>>();
        let candidates = match staged_candidates {
            Some(files) => files,
            None => walk_files(&install.path)?,
        };
        for candidate in candidates {
            let relative = manifest_relative(&install.path, &candidate)?;
            if relative == ".portcove-manifest.json"
                || relative == ".portcove-launched"
                || generated_metadata.contains(&relative)
                || manifest
                    .mutable_file_patterns
                    .iter()
                    .any(|pattern| pattern.matches(&relative))
                || manifest.mutable_paths.iter().any(|mutable| {
                    relative == *mutable || relative.starts_with(&format!("{mutable}/"))
                })
            {
                continue;
            }
            if current_mutable_paths
                .iter()
                .any(|mutable| relative == *mutable || relative.starts_with(&format!("{mutable}/")))
            {
                let executable = install.path.join(&manifest.selected_executable);
                let platform = manifest.platform.unwrap_or(Platform::current()?);
                if (strict_staged && is_executable_member(&candidate, platform)?)
                    || is_executable_companion(&candidate, &executable, platform)?
                {
                    failures.push(format!("unexpected launch-sensitive file: {relative}"));
                }
                continue;
            }
            if !expected.contains(relative.as_str()) {
                failures.push(format!("unexpected: {relative}"));
            }
        }
        Ok(VerificationReport {
            install_id: install.id.clone(),
            checked_files: manifest.files.len() as u64,
            valid: failures.is_empty(),
            failures,
        })
    }

    pub(crate) fn require_curated_operation(
        &self,
        install: &InstallRecord,
        operation: crate::definition_repository::publisher_policy::CuratedArtifactOperation,
    ) -> Result<()> {
        let manifest = verified_manifest(install)?;
        self.require_curated_manifest_operation(install, &manifest, operation)
    }

    fn require_curated_manifest_operation(
        &self,
        install: &InstallRecord,
        manifest: &InstallManifest,
        operation: crate::definition_repository::publisher_policy::CuratedArtifactOperation,
    ) -> Result<()> {
        if let Some((repository_id, record)) = self.curated_manifest_identity(install, manifest)? {
            crate::definition_repository::publisher_policy::require_curated_artifact_operation(
                &self.library.connection()?,
                repository_id,
                &record,
                operation,
            )?;
        }
        Ok(())
    }

    pub(crate) fn assess_curated_operation(
        &self,
        install: &InstallRecord,
        operation: crate::definition_repository::publisher_policy::CuratedArtifactOperation,
    ) -> Result<crate::DefinitionEligibility> {
        let manifest = verified_manifest(install)?;
        if let Some((repository_id, record)) = self.curated_manifest_identity(install, &manifest)? {
            return crate::definition_repository::publisher_policy::assess_curated_artifact_operation(
                &self.library.connection()?, repository_id, &record, operation,
            );
        }
        Ok(crate::DefinitionEligibility {
            outcome: crate::DefinitionEligibilityOutcome::Eligible,
            reason: crate::DefinitionEligibilityReason::MandatoryChecksPassed,
        })
    }

    fn curated_manifest_identity(
        &self,
        install: &InstallRecord,
        manifest: &InstallManifest,
    ) -> Result<Option<(u64, crate::CuratedAcquisitionRecord)>> {
        if let Some(contract) = &manifest.retained_contract {
            let catalog = contract.catalog(&install.port_id)?;
            let platform = manifest.platform.ok_or_else(|| {
                PortcoveError::state("retained artifact has no manifest platform")
            })?;
            if let Some(record) = catalog
                .port(&install.port_id)?
                .release
                .curated
                .get(&platform)
            {
                if record.filename != install.artifact.asset_name
                    || record.sha256 != install.artifact.sha256
                    || record.size != install.artifact.size
                {
                    return Err(PortcoveError::verification(
                        "retained install differs from its exact curated artifact",
                    ));
                }
                let connection = self.library.connection()?;
                let repository_id = crate::curated_acquisition::repository_for_retained_record(
                    &connection,
                    record,
                )?;
                return Ok(Some((repository_id, record.clone())));
            }
        }
        Ok(None)
    }

    pub(crate) fn verify_critical(
        &self,
        install: &InstallRecord,
        qualification: &InstallQualification,
    ) -> Result<PathBuf> {
        let manifest = verified_manifest(install)?;
        // Mutable verification projections may intentionally omit the retained
        // contract. Artifact authority comes from the authenticated manifest,
        // never from the caller's current or mutability-only projection.
        self.require_curated_manifest_operation(
            install,
            &manifest,
            crate::definition_repository::publisher_policy::CuratedArtifactOperation::LocalUse,
        )?;
        if full_immutable_integrity(&manifest, install, qualification.strict_staged_source)? {
            let report = self.verify_managed(install, qualification)?;
            if !report.valid {
                return Err(PortcoveError::verification(format!(
                    "immutable install integrity failed for {}",
                    install.port_id,
                ))
                .detail("install_id", &install.id)
                .detail("failures", report.failures.join(", ")));
            }
        }
        let mut current_mutable = qualification.current_mutable_paths(install)?;
        current_mutable.extend(qualification.generated_metadata_paths(install)?);
        let mut failures = Vec::new();
        failures.extend(mutable_file_pattern_failures(&install.path, &manifest)?);
        if let Some(root) = &manifest.runtime_root {
            for path in walk_files(&install.path.join(root))? {
                let relative = manifest_relative(&install.path, &path)?;
                if !manifest
                    .files
                    .iter()
                    .any(|file| file.path == relative && file.critical)
                {
                    failures.push(format!("unexpected runtime file: {relative}"));
                }
            }
        }
        let executable = install.path.join(&install.selected_executable);
        if !executable.starts_with(&install.path) {
            return Err(PortcoveError::verification(
                "selected executable escaped or disappeared from its install",
            ));
        }
        refuse_symlink_path_within(&install.path, &executable, "selected executable")?;
        let platform = manifest.platform.unwrap_or(Platform::current()?);
        let expected = manifest
            .files
            .iter()
            .map(|file| file.path.as_str())
            .collect::<std::collections::BTreeSet<_>>();
        let executable_directory = executable.parent().ok_or_else(|| {
            PortcoveError::verification("selected executable has no load-sensitive scope")
        })?;
        for entry in fs::read_dir(executable_directory)? {
            let entry = entry?;
            let candidate = entry.path();
            let relative = manifest_relative(&install.path, &candidate)?;
            if expected.contains(relative.as_str())
                || manifest_path_is_mutable(&manifest, &relative)
            {
                continue;
            }
            if current_mutable
                .iter()
                .any(|mutable| relative == *mutable || relative.starts_with(&format!("{mutable}/")))
            {
                refuse_symlink_path_within(&install.path, &candidate, "current mutable path")?;
                let file_type = entry.file_type()?;
                if file_type.is_file()
                    && is_executable_companion(&candidate, &executable, platform)?
                {
                    failures.push(format!("unexpected launch-sensitive file: {relative}"));
                }
                continue;
            }
            let file_type = entry.file_type()?;
            if file_type.is_symlink()
                || (file_type.is_file()
                    && is_critical_companion(&candidate, &executable, platform)?)
            {
                failures.push(format!("unexpected launch-sensitive file: {relative}"));
            }
        }
        for file in &manifest.files {
            let candidate = manifest_member(&install.path, &file.path)?;
            let adjacent_to_executable = candidate.parent() == executable.parent();
            let current_file_type = fs::symlink_metadata(&candidate)
                .ok()
                .map(|metadata| metadata.file_type());
            let recorded_or_current_companion = adjacent_to_executable
                && (file.executable
                    || current_file_type
                        .as_ref()
                        .is_some_and(std::fs::FileType::is_symlink)
                    || is_critical_companion_name(&candidate, platform)
                    || (current_file_type
                        .as_ref()
                        .is_some_and(std::fs::FileType::is_file)
                        && matches!(
                            platform,
                            Platform::LinuxX86_64 | Platform::MacosX86_64 | Platform::MacosAarch64
                        )
                        && crate::permissions::executable_intent(&candidate)?));
            if !file.critical && !recorded_or_current_companion {
                continue;
            }
            if !is_regular_file_without_symlink(&candidate) {
                failures.push(format!("missing: {}", file.path));
                continue;
            }
            let (sha256, size) = hash_file(&candidate)?;
            if size != file.size || sha256 != file.sha256 {
                failures.push(format!("changed: {}", file.path));
            } else if manifest.schema_version >= 5
                && crate::permissions::executable_intent(&candidate)? != file.executable
            {
                failures.push(format!("permissions changed: {}", file.path));
            }
        }
        if !failures.is_empty() {
            return Err(PortcoveError::verification(format!(
                "critical install integrity failed for {}",
                install.port_id
            ))
            .detail("install_id", install.id.clone())
            .detail("failures", failures.join(", ")));
        }
        if let Some(platform) = manifest.platform {
            crate::permissions::require_platform_executable(
                &executable,
                platform,
                "selected executable",
            )?;
        }
        Ok(executable)
    }

    /// A restored local manifest cannot choose its own executable or mutable/critical policy.
    pub(crate) fn verify_import_contract(
        &self,
        install: &InstallRecord,
        qualification: &InstallQualification,
    ) -> Result<()> {
        let manifest = verified_manifest(install)?;
        let mut qualification = qualification.clone();
        if manifest.retained_contract.as_ref().is_some_and(|contract| {
            contract.preparation_mode() == Some(crate::PreparationMode::Ghostship200Legacy)
        }) {
            qualification.critical_paths.extend([
                crate::preparation::RECEIPT_FILE.into(),
                "prepared-game-data/sm64.o2r".into(),
            ]);
        }
        let selected = resolve_declared_executable(&install.path, &qualification)?;
        let (mut files, mutable_paths) = manifest_files(&install.path, &qualification, &selected)?;
        if manifest.schema_version < 5 {
            for file in &mut files {
                file.executable = false;
            }
        }
        let generated_metadata = qualification.generated_metadata_paths(install)?;
        let mut expected_mutable = manifest.mutable_paths.clone();
        expected_mutable.extend(generated_metadata.iter().cloned());
        expected_mutable.extend(qualification.current_mutable_paths(install)?);
        expected_mutable.sort();
        expected_mutable.dedup();
        let original_files: Vec<_> = manifest
            .files
            .iter()
            .filter(|file| file.critical || !generated_metadata.contains(&file.path))
            .collect();
        match (&qualification.runtime, &manifest.runtime) {
            (None, None) => {}
            (Some(required), Some(identity)) if required.same_layout(identity) => {
                let root = manifest_relative(
                    &install.path,
                    &qualification
                        .runtime_root(&install.path, &selected)
                        .join(&required.target_directory),
                )?;
                if manifest.runtime_root.as_ref() != Some(&root) {
                    return Err(PortcoveError::verification(
                        "imported runtime has a different working directory",
                    ));
                }
            }
            _ => {
                return Err(PortcoveError::verification(
                    "imported runtime does not match the current execution contract",
                ));
            }
        }
        if manifest_relative(&install.path, &selected)? != manifest.selected_executable
            || (manifest.schema_version >= 5
                && manifest.platform.as_ref() != Some(&qualification.platform))
            || mutable_paths != expected_mutable
            || qualification.file_patterns(&install.path, &selected)?
                != manifest.mutable_file_patterns
            || serde_json::to_value(files)? != serde_json::to_value(original_files)?
        {
            return Err(PortcoveError::verification(
                "imported application does not match the current platform executable and persistence contract",
            ).detail("install_id", &install.id));
        }
        Ok(())
    }

    pub(crate) fn create_manifest(
        &self,
        install_id: &str,
        port_id: &str,
        version: &str,
        artifact: &ArtifactIdentity,
        qualification: &InstallQualification,
        root: &Path,
    ) -> Result<(String, PathBuf, Option<RuntimeIdentity>)> {
        let mut adopted = qualification.clone();
        adopted.runtime_origin = RuntimeOrigin::AdoptedTree;
        write_manifest(install_id, port_id, version, artifact, &adopted, root)
    }

    pub(crate) fn retained_catalog(
        &self,
        install: &InstallRecord,
    ) -> Result<Option<crate::Catalog>> {
        retained_catalog_for_install(install)
    }

    pub(crate) fn retained_shared_preferences(
        &self,
        install: &InstallRecord,
    ) -> Result<Option<crate::managed_shared_preferences::Acceptance>> {
        Ok(verified_manifest(install)?.shared_preferences)
    }

    pub(crate) fn require_shared_preferences_for(
        &self,
        install: &InstallRecord,
        destination: &Path,
    ) -> Result<()> {
        let manifest = verified_manifest(install)?;
        if let Some(contract) = manifest.retained_contract {
            let catalog = contract.catalog(&install.port_id)?;
            crate::managed_shared_preferences::require_acceptance(
                catalog.port(&install.port_id)?,
                manifest.shared_preferences.as_ref(),
                destination,
            )?;
        } else if manifest.shared_preferences.is_some() {
            return Err(PortcoveError::verification(
                "shared-preferences acceptance has no retained contract",
            ));
        }
        Ok(())
    }

    pub(crate) fn require_same_retained_contract(
        &self,
        original: &InstallRecord,
        derivative: &InstallRecord,
    ) -> Result<()> {
        let original = verified_manifest(original)?
            .retained_contract
            .ok_or_else(|| {
                PortcoveError::verification("historical installation has no retained contract")
            })?;
        let derivative = verified_manifest(derivative)?
            .retained_contract
            .ok_or_else(|| PortcoveError::verification("derivative has no retained contract"))?;
        if serde_json::to_value(&original)? != serde_json::to_value(&derivative)? {
            return Err(PortcoveError::verification(
                "derivative changed its exact historical definition or admission envelope",
            ));
        }
        Ok(())
    }

    fn retained_qualification(
        &self,
        install: &InstallRecord,
        fallback: &InstallQualification,
    ) -> Result<InstallQualification> {
        let manifest = verified_manifest(install)?;
        let mut qualification = match manifest.retained_contract {
            Some(contract) => {
                let catalog = contract.catalog(&install.port_id)?;
                let mut retained = InstallQualification::from_port(
                    catalog.port(&install.port_id)?,
                    fallback.platform,
                )?;
                if contract.preparation_mode() == Some(crate::PreparationMode::Ghostship200Legacy) {
                    retained.critical_paths.extend([
                        crate::preparation::RECEIPT_FILE.into(),
                        "prepared-game-data/sm64.o2r".into(),
                    ]);
                }
                retained.retained_contract = Some(contract);
                retained
            }
            None => fallback.clone(),
        };
        if let Some(runtime) = &install.runtime {
            qualification.runtime_origin = runtime.origin;
        }
        Ok(qualification)
    }

    pub(crate) fn retained_preparation_mode(
        &self,
        install: &InstallRecord,
    ) -> Result<Option<crate::PreparationMode>> {
        Ok(verified_manifest(install)?
            .retained_contract
            .and_then(|contract| contract.preparation_mode()))
    }

    pub(crate) fn refresh_verified_manifest(
        &self,
        install: &InstallRecord,
        qualification: &InstallQualification,
    ) -> Result<InstallRecord> {
        // Refuse before touching the manifest, not after an irreversible identity
        // change is already visible to profiles or a concurrent observer.
        crate::retained_build::require_unreferenced_install(
            &self.library.connection()?,
            &install.id,
        )?;
        let qualification = self.retained_qualification(install, qualification)?;
        let (manifest_sha256, selected_executable, runtime) = write_manifest(
            &install.id,
            &install.port_id,
            &install.version,
            &install.artifact,
            &qualification,
            &install.path,
        )?;
        let mut refreshed = install.clone();
        refreshed.manifest_sha256 = manifest_sha256;
        refreshed.selected_executable = selected_executable;
        refreshed.runtime = runtime;
        Ok(refreshed)
    }

    pub(crate) fn create_prepared_manifest(
        &self,
        original: &InstallRecord,
        operation_id: &str,
        qualification: &InstallQualification,
        mode: crate::PreparationMode,
        root: &Path,
    ) -> Result<InstallRecord> {
        let mut qualification = self.retained_qualification(original, qualification)?;
        qualification
            .critical_paths
            .push(crate::preparation::RECEIPT_FILE.into());
        if mode == crate::PreparationMode::Ghostship200Legacy {
            crate::preparation::legacy_execution_contract(
                &self
                    .retained_catalog(original)?
                    .ok_or_else(|| {
                        PortcoveError::verification(
                            "legacy preparation requires a retained definition",
                        )
                    })?
                    .port(&original.port_id)?
                    .clone(),
                original,
                Platform::WindowsX86_64,
            )?;
            qualification.retained_contract = Some(
                qualification
                    .retained_contract
                    .as_ref()
                    .ok_or_else(|| {
                        PortcoveError::verification(
                            "legacy preparation requires its verified original contract",
                        )
                    })?
                    .for_ghostship_legacy_preparation()?,
            );
            qualification
                .critical_paths
                .push("prepared-game-data/sm64.o2r".into());
        }
        let (manifest_sha256, selected_executable, runtime) = write_manifest(
            operation_id,
            &original.port_id,
            &original.version,
            &original.artifact,
            &qualification,
            root,
        )?;
        Ok(InstallRecord {
            id: operation_id.into(),
            path: root.into(),
            installed_at: Library::now(),
            verified: true,
            staged: false,
            manifest_sha256,
            selected_executable,
            runtime,
            ..original.clone()
        })
    }
}

/// Exact metadata from the already registered manifest. This does not confer
/// trust or prove current payload integrity; callers retain those existing checks.
pub(crate) fn retained_build_identity_for_install(
    install: &InstallRecord,
) -> Result<crate::RetainedBuildIdentity> {
    let manifest = verified_manifest(install)?;
    let contract = manifest.retained_contract.ok_or_else(|| {
        PortcoveError::unsupported("installation has no retained exact definition contract")
    })?;
    let catalog = contract.catalog(&install.port_id)?;
    // Canonical object order is independent of Rust declaration order and the
    // workspace's serde_json preserve_order feature unification. The registered
    // manifest digest separately binds the original exact on-disk bytes.
    let mut contract_value = serde_json::to_value(&contract)?;
    contract_value.sort_all_objects();
    Ok(crate::RetainedBuildIdentity {
        install_id: install.id.clone(),
        port_id: install.port_id.clone(),
        artifact: install.artifact.clone(),
        manifest_sha256: install.manifest_sha256.clone(),
        selected_executable: install.selected_executable.clone(),
        runtime: install.runtime.clone(),
        installed_contract_sha256: hex::encode(Sha256::digest(serde_json::to_vec(
            &contract_value,
        )?)),
        definition: catalog.definition_selection(&install.port_id).cloned(),
        platform: manifest.platform.ok_or_else(|| {
            PortcoveError::verification("retained build has no recorded platform")
        })?,
    })
}

pub(crate) fn retained_catalog_for_install(
    install: &InstallRecord,
) -> Result<Option<crate::Catalog>> {
    let manifest = verified_manifest(install)?;
    catalog_for_verified_manifest(install, &manifest)
}

#[derive(Deserialize)]
struct LegacyDkrArtifact {
    version: String,
    platform: Platform,
    asset_name: String,
    size: u64,
    sha256: String,
    executable: String,
}

fn legacy_dkr_artifact(
    install: &InstallRecord,
    manifest: &InstallManifest,
) -> Result<Option<LegacyDkrArtifact>> {
    if install.port_id != "dkr-r" || manifest.retained_contract.is_some() {
        return Ok(None);
    }
    // Only verified pre-contract manifests reach here. Never derive historical
    // launch or persistence from today's non-owning definition or host platform.
    let artifacts: Vec<LegacyDkrArtifact> =
        serde_json::from_str(include_str!("legacy_dkr/artifacts.json"))?;
    let artifact = artifacts.into_iter().find(|artifact| {
        install.version == artifact.version
            && install.artifact.asset_name == artifact.asset_name
            && install.artifact.size == artifact.size
            && install.artifact.sha256 == artifact.sha256
            && Path::new(&install.selected_executable).file_name()
                == Some(std::ffi::OsStr::new(&artifact.executable))
            && manifest
                .platform
                .is_none_or(|platform| platform == artifact.platform)
            && manifest.runtime.is_none()
    });
    artifact.map(Some).ok_or_else(|| PortcoveError::verification(
        "legacy DKR-R installation is outside the recorded compatibility identities; preserve its files and review its original contract",
    ))
}

fn catalog_for_verified_manifest(
    install: &InstallRecord,
    manifest: &InstallManifest,
) -> Result<Option<crate::Catalog>> {
    if let Some(contract) = &manifest.retained_contract {
        return contract.catalog(&install.port_id).map(Some);
    }
    let Some(artifact) = legacy_dkr_artifact(install, manifest)? else {
        return Ok(None);
    };
    // Frozen local interpretation only. Acquisition still uses the active
    // catalog and cannot obtain a managed release through this reader.
    let mut document: crate::CatalogDocument =
        serde_json::from_str(include_str!("legacy_dkr/catalog.json"))?;
    if artifact.platform == Platform::LinuxX86_64 {
        document.ports[0]
            .executable_hints
            .insert(artifact.platform, vec![artifact.executable]);
    }
    crate::Catalog::from_json(&serde_json::to_string(&document)?).map(Some)
}

#[cfg(test)]
mod legacy_dkr_tests {
    use super::*;

    fn fixture(
        artifact: &LegacyDkrArtifact,
        schema: u32,
    ) -> (tempfile::TempDir, Installer, InstallRecord) {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let root = library.versions_dir().join("dkr-r/legacy");
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join(&artifact.executable),
            b"inert historical runtime fixture",
        )
        .unwrap();
        crate::permissions::normalize_archive_entry(&root.join(&artifact.executable), false, true)
            .unwrap();
        let artifact_identity = ArtifactIdentity {
            asset_name: artifact.asset_name.clone(),
            size: artifact.size,
            sha256: artifact.sha256.clone(),
        };
        let manifest = InstallManifest {
            schema_version: schema,
            retained_contract: None,
            shared_preferences: None,
            platform: (schema >= 5).then_some(artifact.platform),
            install_id: "legacy".into(),
            port_id: "dkr-r".into(),
            version: artifact.version.clone(),
            artifact: artifact_identity.clone(),
            runtime: None,
            runtime_root: None,
            selected_executable: artifact.executable.clone(),
            mutable_paths: vec![
                "dkr-runtime-data".into(),
                "imgui.ini".into(),
                "dkr-us-v80.z64".into(),
            ],
            mutable_file_patterns: vec![],
            files: vec![ManifestFile {
                path: artifact.executable.clone(),
                size: 32,
                sha256: hex::encode(Sha256::digest(b"inert historical runtime fixture")),
                critical: true,
                executable: schema >= 5
                    && crate::permissions::platform_requires_executable(artifact.platform),
            }],
        };
        let bytes = serde_json::to_vec(&manifest).unwrap();
        fs::write(root.join(".portcove-manifest.json"), &bytes).unwrap();
        let install = InstallRecord {
            id: "legacy".into(),
            port_id: "dkr-r".into(),
            version: artifact.version.clone(),
            path: root,
            channel: crate::ReleaseChannel::Stable,
            installed_at: 1,
            verified: true,
            staged: false,
            artifact: artifact_identity,
            manifest_sha256: hex::encode(Sha256::digest(bytes)),
            selected_executable: artifact.executable.clone().into(),
            runtime: None,
        };
        (temporary, Installer::new(library).unwrap(), install)
    }

    #[test]
    fn legacy_dkr_manifests_preserve_exact_runtime_source_and_data_contracts() {
        let artifacts: Vec<LegacyDkrArtifact> =
            serde_json::from_str(include_str!("legacy_dkr/artifacts.json")).unwrap();
        for artifact in &artifacts {
            for schema in 2..=5 {
                let (_temporary, installer, install) = fixture(artifact, schema);
                let before = fs::read(install.path.join(".portcove-manifest.json")).unwrap();
                let (catalog, platform) = retained_query_context(&install).unwrap();
                assert_eq!(platform, Some(artifact.platform));
                let catalog = catalog.unwrap();
                let port = catalog.port("dkr-r").unwrap();
                assert_eq!(
                    port.launch_arguments,
                    ["--rom", "dkr-us-v80.z64", "--config", "dkr-runtime-data"]
                );
                assert_eq!(port.source_profile.as_deref(), Some("diddy-kong-racing"));
                assert_eq!(
                    port.persistent_paths,
                    ["dkr-runtime-data", "imgui.ini", "dkr-us-v80.z64"]
                );
                let qualification =
                    InstallQualification::from_catalog(&catalog, "dkr-r", artifact.platform)
                        .unwrap();
                // Cross-platform metadata remains readable, but this host
                // cannot represent another platform's executable permissions.
                // Exercise native integrity without weakening those guards.
                let native = artifact.platform == Platform::current().unwrap();
                if native {
                    installer.verify_critical(&install, &qualification).unwrap();
                }
                fs::create_dir(install.path.join("dkr-runtime-data")).unwrap();
                fs::write(
                    install.path.join("dkr-runtime-data/save"),
                    b"retained player data",
                )
                .unwrap();
                if native {
                    installer.verify_critical(&install, &qualification).unwrap();
                }
                assert_eq!(
                    fs::read(install.path.join(".portcove-manifest.json")).unwrap(),
                    before
                );
                fs::write(install.path.join(&artifact.executable), b"changed runtime").unwrap();
                if native {
                    assert!(installer.verify_critical(&install, &qualification).is_err());
                }
            }
        }
    }

    #[test]
    fn legacy_dkr_fallback_refuses_unknown_identity_and_preserves_captured_authority() {
        let artifacts: Vec<LegacyDkrArtifact> =
            serde_json::from_str(include_str!("legacy_dkr/artifacts.json")).unwrap();
        let artifact = &artifacts[2];
        let (_temporary, installer, mut install) = fixture(artifact, 5);
        let mut manifest = verified_manifest(&install).unwrap();
        let historical = catalog_for_verified_manifest(&install, &manifest)
            .unwrap()
            .unwrap();
        for changed in ["digest", "platform", "version", "executable"] {
            let mut candidate = install.clone();
            let mut document = manifest.clone();
            match changed {
                "digest" => candidate.artifact.sha256 = "a".repeat(64),
                "platform" => document.platform = Some(Platform::LinuxX86_64),
                "version" => candidate.version = "Version1.0.8".into(),
                _ => candidate.selected_executable = "other.exe".into(),
            }
            assert!(
                legacy_dkr_artifact(&candidate, &document).is_err(),
                "{changed}"
            );
        }
        // Captured contracts remain authoritative even outside the small legacy
        // artifact fence; no current definition is substituted for their data.
        install.version = "inert-captured-fixture".into();
        install.artifact.sha256 = "b".repeat(64);
        manifest.version.clone_from(&install.version);
        manifest.artifact = install.artifact.clone();
        manifest.schema_version = 6;
        manifest.retained_contract = Some(
            crate::installed_contract::InstalledContract::capture(&historical, "dkr-r").unwrap(),
        );
        let bytes = serde_json::to_vec(&manifest).unwrap();
        fs::write(install.path.join(".portcove-manifest.json"), &bytes).unwrap();
        install.manifest_sha256 = hex::encode(Sha256::digest(bytes));
        assert!(installer.retained_catalog(&install).unwrap().is_some());
        let current = crate::Catalog::embedded().unwrap();
        assert!(
            InstallQualification::from_catalog(&current, "dkr-r", Platform::WindowsX86_64).is_err()
        );
    }

    #[cfg(windows)]
    #[test]
    fn legacy_dkr_service_collects_and_rolls_back_without_offering_new_managed_updates() {
        let artifacts: Vec<LegacyDkrArtifact> =
            serde_json::from_str(include_str!("legacy_dkr/artifacts.json")).unwrap();
        let (_temporary, installer, active) = fixture(&artifacts[2], 5);
        let library = installer.library.clone();
        let mut prior = active.clone();
        prior.id = "previous".into();
        prior.version = artifacts[0].version.clone();
        prior.artifact = ArtifactIdentity {
            asset_name: artifacts[0].asset_name.clone(),
            size: artifacts[0].size,
            sha256: artifacts[0].sha256.clone(),
        };
        prior.path = library.versions_dir().join("dkr-r/previous");
        fs::create_dir_all(&prior.path).unwrap();
        fs::copy(
            active.path.join(&active.selected_executable),
            prior.path.join(&prior.selected_executable),
        )
        .unwrap();
        let mut manifest = verified_manifest(&active).unwrap();
        manifest.install_id = prior.id.clone();
        manifest.version = prior.version.clone();
        manifest.artifact = prior.artifact.clone();
        let bytes = serde_json::to_vec(&manifest).unwrap();
        fs::write(prior.path.join(".portcove-manifest.json"), &bytes).unwrap();
        prior.manifest_sha256 = hex::encode(Sha256::digest(bytes));
        library.register_install(&prior, true).unwrap();
        library.register_install(&active, true).unwrap();
        let service = crate::PortcoveService::new(library.clone()).unwrap();
        let retained = service.installed_catalog(&active).unwrap();
        assert_eq!(
            retained.port("dkr-r").unwrap().launch_arguments,
            ["--rom", "dkr-us-v80.z64", "--config", "dkr-runtime-data"]
        );
        installer
            .verify_critical(
                &active,
                &service.installed_mutability_qualification(&active).unwrap(),
            )
            .unwrap();
        fs::create_dir(active.path.join("dkr-runtime-data")).unwrap();
        fs::write(
            active.path.join("dkr-runtime-data/save"),
            b"retained ordinary-exit save",
        )
        .unwrap();
        service
            .collect_user_data_from_install("dkr-r", &active.path)
            .unwrap();
        assert_eq!(
            fs::read(library.user_dir("dkr-r").join("dkr-runtime-data/save")).unwrap(),
            b"retained ordinary-exit save"
        );
        assert_eq!(service.rollback("dkr-r").unwrap().id, prior.id);
        assert_eq!(
            fs::read(prior.path.join("dkr-runtime-data/save")).unwrap(),
            b"retained ordinary-exit save"
        );
        assert!(active.path.join(&active.selected_executable).is_file());
        assert!(prior.path.join(&prior.selected_executable).is_file());
        let current = crate::Catalog::embedded().unwrap();
        assert!(
            InstallQualification::from_catalog(&current, "dkr-r", Platform::WindowsX86_64).is_err()
        );
    }
}

/// Explicit query-context observation. Legacy manifests do not acquire a
/// guessed host platform; oversized metadata remains unavailable to this reader.
pub(crate) fn retained_query_context(
    install: &InstallRecord,
) -> Result<(Option<crate::Catalog>, Option<Platform>)> {
    retained_query_context_with_budget(install, None)
}

/// The workspace owns a single request-wide metadata allowance. Failed bounded
/// reads spend their ceiling; successfully returned bytes spend their actual size.
pub(crate) fn retained_query_context_with_budget(
    install: &InstallRecord,
    budget: Option<&mut u64>,
) -> Result<(Option<crate::Catalog>, Option<Platform>)> {
    let manifest = verified_manifest_with_budget(
        install,
        Some(crate::signed_catalog::MAX_CATALOG_BYTES as u64),
        budget,
    )?;
    let catalog = catalog_for_verified_manifest(install, &manifest)?;
    let platform = manifest
        .platform
        .or(legacy_dkr_artifact(install, &manifest)?.map(|artifact| artifact.platform));
    Ok((catalog, platform))
}

pub(crate) fn portability_catalog_for_install(
    install: &InstallRecord,
    embedded: &crate::Catalog,
) -> Result<Option<crate::Catalog>> {
    let manifest = install.path.join(".portcove-manifest.json");
    if embedded.port(&install.port_id).is_ok()
        && matches!(
            fs::symlink_metadata(&manifest),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound
        )
    {
        // Legacy metadata can name an embedded install without carrying the newer retained
        // manifest. It receives only the embedded contract and cannot claim successor admission.
        crate::managed_shared_preferences::refuse_scope_transfer(embedded.port(&install.port_id)?)?;
        return Ok(None);
    }
    let retained = retained_catalog_for_install(install)?;
    if let Some(catalog) = &retained {
        crate::managed_shared_preferences::refuse_scope_transfer(catalog.port(&install.port_id)?)?;
    }
    Ok(retained)
}

fn write_manifest(
    install_id: &str,
    port_id: &str,
    version: &str,
    artifact: &ArtifactIdentity,
    qualification: &InstallQualification,
    root: &Path,
) -> Result<(String, PathBuf, Option<RuntimeIdentity>)> {
    let retained_contract = qualification.retained_contract.as_ref().ok_or_else(|| {
        PortcoveError::verification("manifest publication requires the exact catalog contract")
    })?;
    if retained_contract.port_id() != port_id {
        return Err(PortcoveError::verification(
            "manifest and retained port identity differ",
        ));
    }
    let catalog = retained_contract.catalog(port_id)?;
    crate::managed_shared_preferences::require_artifact(
        catalog.port(port_id)?,
        version,
        artifact,
        Some(qualification.platform),
    )?;
    match (
        catalog.port(port_id)?.managed_shared_preferences,
        &qualification.shared_preferences,
    ) {
        (None, None) => {}
        (Some(_), Some(accepted)) => accepted.validate_for(catalog.port(port_id)?)?,
        _ => {
            return Err(PortcoveError::verification(
                "manifest publication has no exact shared-preferences acceptance",
            ));
        }
    }
    if qualification.runtime_data_policy != catalog.port(port_id)?.runtime_data_policy {
        return Err(PortcoveError::verification(
            "credential policy differs from the retained qualification",
        ));
    }
    crate::runtime_data_policy::require_artifact(
        catalog.port(port_id)?,
        version,
        artifact,
        Some(qualification.platform),
    )?;
    validate_artifact(artifact)?;
    let selected = resolve_declared_executable(root, qualification)?;
    let selected_relative = manifest_relative(root, &selected)?;
    let (files, mutable_paths) = manifest_files(root, qualification, &selected)?;
    if !files
        .iter()
        .any(|file| file.path == selected_relative && file.critical)
    {
        return Err(PortcoveError::verification(
            "selected executable is not in the immutable critical manifest set",
        ));
    }
    let runtime_root = qualification
        .runtime
        .as_ref()
        .map(|spec| {
            manifest_relative(
                root,
                &qualification
                    .runtime_root(root, &selected)
                    .join(&spec.target_directory),
            )
        })
        .transpose()?;
    let runtime = manifest_runtime(qualification, &files, runtime_root.as_deref())?;
    if let Some(runtime_root) = &runtime_root {
        for path in walk_files(&root.join(runtime_root))? {
            let relative = manifest_relative(root, &path)?;
            if !files
                .iter()
                .any(|file| file.path == relative && file.critical)
            {
                return Err(PortcoveError::verification(
                    "runtime contains an excluded or mutable file",
                ));
            }
        }
    }
    let manifest = InstallManifest {
        schema_version: if qualification.shared_preferences.is_some() {
            7
        } else {
            6
        },
        retained_contract: Some(retained_contract.clone()),
        shared_preferences: qualification.shared_preferences.clone(),
        platform: Some(qualification.platform),
        runtime: runtime.clone(),
        runtime_root,
        install_id: install_id.into(),
        port_id: port_id.into(),
        version: version.into(),
        artifact: artifact.clone(),
        selected_executable: selected_relative.clone(),
        mutable_paths,
        mutable_file_patterns: qualification.file_patterns(root, &selected)?,
        files,
    };
    let bytes = serde_json::to_vec_pretty(&manifest)?;
    let manifest_sha256 = hex::encode(Sha256::digest(&bytes));
    replace_manifest(root, &bytes)?;
    Ok((manifest_sha256, PathBuf::from(selected_relative), runtime))
}

fn replace_manifest(root: &Path, bytes: &[u8]) -> Result<()> {
    crate::durability::write_bytes_atomically(&root.join(".portcove-manifest.json"), bytes, true)
}

fn manifest_files(
    root: &Path,
    qualification: &InstallQualification,
    selected: &Path,
) -> Result<(Vec<ManifestFile>, Vec<String>)> {
    let persistence_root = qualification.persistence_root(root, selected);
    let runtime_root = qualification.runtime.as_ref().map(|runtime| {
        qualification
            .runtime_root(root, selected)
            .join(&runtime.target_directory)
    });
    if let Some(runtime) = &qualification.runtime {
        crate::runtime::require_executable(
            runtime_root.as_ref().expect("runtime root"),
            runtime,
            qualification.platform,
        )?;
    }
    let working_root = qualification.runtime_root(root, selected);
    let critical_roots = qualification
        .critical_paths
        .iter()
        .map(|relative| working_root.join(relative))
        .collect::<Vec<_>>();
    if critical_roots.iter().any(|path| !path.starts_with(root)) {
        return Err(PortcoveError::verification(
            "critical path escaped the install root",
        ));
    }
    let protected_roots = qualification
        .protected_paths
        .iter()
        .map(|relative| working_root.join(relative))
        .collect::<Vec<_>>();
    if protected_roots.iter().any(|path| !path.starts_with(root)) {
        return Err(PortcoveError::verification(
            "protected path escaped the install root",
        ));
    }
    let candidates = qualification
        .persistent_paths
        .iter()
        .map(|relative| persistence_root.join(relative))
        .chain(
            qualification
                .runtime_mutable_paths
                .iter()
                .map(|relative| working_root.join(relative)),
        )
        .chain(
            qualification
                .generated_metadata
                .iter()
                .map(|relative| working_root.join(relative)),
        );
    let mut mutable_roots = Vec::new();
    for path in candidates {
        if !path.starts_with(root) {
            return Err(PortcoveError::verification(
                "persistent path escaped the install root",
            ));
        }
        if let Some(runtime) = &runtime_root
            && crate::runtime::overlaps(
                &crate::path::unicode(&path, "mutable path")?,
                &crate::path::unicode(runtime, "runtime root")?,
            )
        {
            return Err(PortcoveError::verification(
                "runtime overlaps resolved persistent data",
            ));
        }
        mutable_roots.push(path);
    }
    let mut mutable_paths = mutable_roots
        .iter()
        .map(|path| manifest_relative(root, path))
        .collect::<Result<Vec<_>>>()?;
    mutable_paths.sort();
    mutable_paths.dedup();

    let mut files = Vec::new();
    let file_patterns = qualification.file_patterns(root, selected)?;
    for path in walk_files(root)? {
        let relative = manifest_relative(root, &path)?;
        let matched_file = file_patterns
            .iter()
            .any(|pattern| pattern.matches(&relative));
        if matched_file
            && (path == selected
                || is_critical_companion(&path, selected, qualification.platform)?
                || runtime_root
                    .as_ref()
                    .is_some_and(|runtime| path.starts_with(runtime))
                || critical_roots
                    .iter()
                    .any(|critical| path == *critical || path.starts_with(critical))
                || protected_roots
                    .iter()
                    .any(|protected| path == *protected || path.starts_with(protected)))
        {
            return Err(PortcoveError::verification(
                "mutable file pattern matched executable, source, or bootstrap content",
            ));
        }
        if path.file_name().and_then(|value| value.to_str()) == Some(".portcove-manifest.json")
            || path.file_name().and_then(|value| value.to_str()) == Some(".portcove-launched")
            || mutable_roots
                .iter()
                .any(|mutable| path == *mutable || path.starts_with(mutable))
            || matched_file
        {
            continue;
        }
        let (sha256, size) = hash_file(&path)?;
        files.push(ManifestFile {
            critical: qualification.runtime.is_some()
                || path == selected
                || is_critical_companion(&path, selected, qualification.platform)?
                || critical_roots
                    .iter()
                    .any(|critical| path == *critical || path.starts_with(critical))
                || runtime_root
                    .as_ref()
                    .is_some_and(|runtime| path.starts_with(runtime)),
            path: relative,
            size,
            sha256,
            executable: crate::permissions::executable_intent(&path)?,
        });
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok((files, mutable_paths))
}

fn immutable_member(install: &InstallRecord, relative: &str) -> Result<ManifestFile> {
    crate::path::refuse_symlink_ancestors(&install.path)?;
    refuse_symlink_path_within(
        &install.path,
        &manifest_member(&install.path, relative)?,
        "prepared metadata",
    )?;
    let manifest = verified_manifest(install)?;
    if manifest_path_is_mutable(&manifest, relative) {
        return Err(PortcoveError::verification(
            "prepared metadata cannot be mutable",
        ));
    }
    manifest
        .files
        .into_iter()
        .find(|file| file.path == relative)
        .ok_or_else(|| {
            PortcoveError::not_found("prepared metadata is not in the admitted manifest")
        })
}

pub(crate) fn verified_launch_subject(install: &InstallRecord) -> Result<[u8; 32]> {
    let manifest = verified_manifest(install)?;
    let platform = manifest.platform.ok_or_else(|| {
        PortcoveError::verification("accepted launch checks require the retained manifest platform")
    })?;
    crate::definition_repository::publisher_policy::launch_assessment::verified_subject_key(
        install, platform,
    )
}

fn verified_manifest(install: &InstallRecord) -> Result<InstallManifest> {
    verified_manifest_with_limit(install, None)
}

fn verified_manifest_with_limit(
    install: &InstallRecord,
    maximum_bytes: Option<u64>,
) -> Result<InstallManifest> {
    verified_manifest_with_budget(install, maximum_bytes, None)
}

fn verified_manifest_with_budget(
    install: &InstallRecord,
    maximum_bytes: Option<u64>,
    budget: Option<&mut u64>,
) -> Result<InstallManifest> {
    validate_artifact(&install.artifact)?;
    if install.manifest_sha256.len() != 64
        || !install
            .manifest_sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(PortcoveError::verification(
            "install has no current immutable manifest identity",
        ));
    }
    let manifest_path = install.path.join(".portcove-manifest.json");
    let maximum_bytes = match budget.as_deref() {
        Some(0) => {
            return Err(PortcoveError::unsupported(
                "browsing metadata budget reached",
            ));
        }
        Some(remaining) => Some(maximum_bytes.unwrap_or(*remaining).min(*remaining)),
        None => maximum_bytes,
    };
    let read = match maximum_bytes {
        Some(limit) => crate::external_runtime::read_stable_metadata(&manifest_path, limit)
            .map_err(std::io::Error::other),
        None => fs::read(&manifest_path),
    };
    if let Some(remaining) = budget {
        let spent = read
            .as_ref()
            .map_or(maximum_bytes.unwrap_or(*remaining), |bytes| {
                bytes.len() as u64
            });
        *remaining = remaining.saturating_sub(spent);
    }
    let bytes = read.map_err(|_| {
        PortcoveError::verification(format!("manifest is missing for {}", install.port_id))
    })?;
    let actual_manifest_sha256 = hex::encode(Sha256::digest(&bytes));
    if actual_manifest_sha256 != install.manifest_sha256 {
        return Err(PortcoveError::verification(
            "install manifest bytes do not match the registered identity",
        ));
    }
    let manifest: InstallManifest = serde_json::from_slice(&bytes)?;
    let selected = manifest_relative(
        &install.path,
        &install.path.join(&install.selected_executable),
    )?;
    let mut manifest_paths = std::collections::BTreeSet::new();
    for file in &manifest.files {
        manifest_member(&install.path, &file.path)?;
        if file.sha256.len() != 64
            || !file.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
            || !manifest_paths.insert(file.path.as_str())
        {
            return Err(PortcoveError::verification(
                "install manifest contains an invalid or duplicate file identity",
            ));
        }
    }
    for mutable in &manifest.mutable_paths {
        manifest_member(&install.path, mutable)?;
    }
    for pattern in &manifest.mutable_file_patterns {
        pattern.pattern.validate()?;
        if let Some(directory) = &pattern.directory {
            manifest_member(&install.path, directory)?;
        }
        if pattern.matches(&selected)
            || manifest.runtime_root.as_ref().is_some_and(|runtime| {
                pattern.directory.as_ref().is_some_and(|directory| {
                    directory == runtime || directory.starts_with(&format!("{runtime}/"))
                })
            })
        {
            return Err(PortcoveError::verification(
                "mutable file pattern overlaps the executable or immutable runtime",
            ));
        }
    }
    if !matches!(manifest.schema_version, 2..=7)
        || (manifest.schema_version == 7) != manifest.shared_preferences.is_some()
        || (manifest.schema_version < 6 && manifest.retained_contract.is_some())
        || (manifest.schema_version >= 6 && manifest.retained_contract.is_none())
        || (manifest.schema_version < 4 && !manifest.mutable_file_patterns.is_empty())
        || (manifest.schema_version < 5
            && (manifest.platform.is_some() || manifest.files.iter().any(|file| file.executable)))
        || (manifest.schema_version >= 5 && manifest.platform.is_none())
        || (manifest.schema_version == 2 && manifest.runtime.is_some())
        || manifest.runtime != install.runtime
        || manifest.install_id != install.id
        || manifest.port_id != install.port_id
        || manifest.version != install.version
        || manifest.artifact != install.artifact
        || manifest.selected_executable != selected
        || !manifest.files.iter().any(|file| {
            file.path == selected
                && file.critical
                && (!manifest
                    .platform
                    .is_some_and(crate::permissions::platform_requires_executable)
                    || file.executable)
        })
    {
        return Err(PortcoveError::verification(
            "install manifest identity does not match the registered install",
        ));
    }
    validate_runtime_manifest(&manifest)?;
    if let Some(contract) = &manifest.retained_contract {
        let catalog = contract.catalog(&install.port_id)?;
        crate::managed_shared_preferences::require_artifact(
            catalog.port(&install.port_id)?,
            &install.version,
            &install.artifact,
            manifest.platform,
        )?;
        match (
            catalog.port(&install.port_id)?.managed_shared_preferences,
            &manifest.shared_preferences,
        ) {
            (None, None) => {}
            (Some(_), Some(accepted)) => accepted.validate_for(catalog.port(&install.port_id)?)?,
            _ => {
                return Err(PortcoveError::verification(
                    "retained manifest has no matching shared-preferences acceptance",
                ));
            }
        }
        crate::runtime_data_policy::require_artifact(
            catalog.port(&install.port_id)?,
            &install.version,
            &install.artifact,
            manifest.platform,
        )?;
        crate::managed_tfe::require_artifact(
            catalog.port(&install.port_id)?,
            &install.version,
            &install.artifact,
            manifest.platform,
        )?;
        if contract.preparation_mode() == Some(crate::PreparationMode::Ghostship200Legacy) {
            if manifest.platform != Some(Platform::WindowsX86_64) {
                return Err(PortcoveError::verification(
                    "legacy prepared manifest is not the reviewed Windows target",
                ));
            }
            crate::preparation::legacy_execution_contract(
                catalog.port(&install.port_id)?,
                install,
                Platform::WindowsX86_64,
            )?;
            for (path, maximum) in [
                (crate::preparation::RECEIPT_FILE, 1024 * 1024),
                ("prepared-game-data/sm64.o2r", 512 * 1024 * 1024),
            ] {
                if !manifest.files.iter().any(|file| {
                    file.path == path && file.critical && file.size > 0 && file.size <= maximum
                }) {
                    return Err(PortcoveError::verification(
                        "legacy prepared manifest lacks a bounded critical receipt or generated archive",
                    ));
                }
            }
        }
    }
    Ok(manifest)
}

fn manifest_runtime(
    qualification: &InstallQualification,
    files: &[ManifestFile],
    root: Option<&str>,
) -> Result<Option<RuntimeIdentity>> {
    let Some(spec) = &qualification.runtime else {
        return Ok(None);
    };
    let root =
        root.ok_or_else(|| PortcoveError::verification("runtime manifest root is missing"))?;
    let mut identity = spec.identity();
    if qualification.runtime_origin == RuntimeOrigin::AdoptedTree {
        identity.origin = RuntimeOrigin::AdoptedTree;
        identity.artifact = adopted_runtime_artifact(files, root)?;
    }
    Ok(Some(identity))
}

fn adopted_runtime_artifact(files: &[ManifestFile], root: &str) -> Result<ArtifactIdentity> {
    let prefix = format!("{root}/");
    let members: Vec<_> = files
        .iter()
        .filter(|file| file.path.starts_with(&prefix))
        .collect();
    Ok(ArtifactIdentity {
        asset_name: "adopted-runtime-tree".into(),
        sha256: hex::encode(Sha256::digest(serde_json::to_vec(&members)?)),
        size: members.iter().try_fold(0_u64, |total, file| {
            total
                .checked_add(file.size)
                .ok_or_else(|| PortcoveError::verification("runtime tree size overflowed"))
        })?,
    })
}

fn validate_runtime_manifest(manifest: &InstallManifest) -> Result<()> {
    let (identity, root) = match (&manifest.runtime, &manifest.runtime_root) {
        (None, None) => return Ok(()),
        (Some(identity), Some(root)) => (identity, root),
        _ => {
            return Err(PortcoveError::verification(
                "runtime manifest identity is incomplete",
            ));
        }
    };
    validate_artifact(&identity.artifact)?;
    for path in [
        root,
        &identity.target_directory,
        &identity.executable,
        &identity.archive_root,
    ] {
        crate::archive::validate_relative_path(path, false)?;
    }
    let executable = format!("{root}/{}", identity.executable);
    if !manifest.files.iter().any(|file| {
        file.path == executable
            && file.critical
            && (!manifest
                .platform
                .is_some_and(crate::permissions::platform_requires_executable)
                || manifest.schema_version < 5
                || file.executable)
    }) || manifest.files.iter().any(|file| !file.critical)
        || manifest.mutable_paths.iter().any(|path| {
            root == path
                || root.starts_with(&format!("{path}/"))
                || path.starts_with(&format!("{root}/"))
        })
    {
        return Err(PortcoveError::verification(
            "runtime-dependent installations require complete immutable critical coverage",
        ));
    }
    if identity.origin == RuntimeOrigin::AdoptedTree
        && identity.artifact != adopted_runtime_artifact(&manifest.files, root)?
    {
        return Err(PortcoveError::verification(
            "adopted runtime tree does not match its recorded identity",
        ));
    }
    Ok(())
}

fn manifest_member(root: &Path, relative: &str) -> Result<PathBuf> {
    use std::path::Component;

    let path = Path::new(relative);
    if relative.is_empty()
        || relative.contains('\\')
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(PortcoveError::verification(
            "install manifest contains an unsafe relative path",
        ));
    }
    Ok(root.join(path))
}

fn validate_artifact(artifact: &ArtifactIdentity) -> Result<()> {
    if artifact.asset_name.is_empty()
        || artifact.sha256.len() != 64
        || !artifact.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(PortcoveError::verification(
            "install has no valid immutable artifact identity",
        ));
    }
    Ok(())
}

fn artifact_storage_key(sha256: &str) -> Result<String> {
    let artifact = ArtifactIdentity {
        asset_name: "storage-key".into(),
        sha256: sha256.to_ascii_lowercase(),
        size: 0,
    };
    validate_artifact(&artifact)?;
    Ok(artifact.sha256)
}

pub(crate) fn local_artifact_identity(
    root: &Path,
    qualification: &InstallQualification,
) -> Result<ArtifactIdentity> {
    let selected = resolve_declared_executable(root, qualification)?;
    let (files, _) = manifest_files(root, qualification, &selected)?;
    let mut hasher = Sha256::new();
    let mut size = 0_u64;
    for file in files {
        hasher.update(file.path.as_bytes());
        hasher.update([0]);
        hasher.update(file.size.to_le_bytes());
        hasher.update(file.sha256.as_bytes());
        if crate::permissions::platform_requires_executable(qualification.platform) {
            hasher.update([u8::from(file.executable)]);
        }
        size = size
            .checked_add(file.size)
            .ok_or_else(|| PortcoveError::verification("local artifact size overflowed"))?;
    }
    Ok(ArtifactIdentity {
        asset_name: "local-adoption".into(),
        sha256: hex::encode(hasher.finalize()),
        size,
    })
}

pub(crate) fn resolve_declared_executable(
    root: &Path,
    qualification: &InstallQualification,
) -> Result<PathBuf> {
    let search_root = qualification
        .runtime_subdirectory
        .as_deref()
        .map(|relative| root.join(relative))
        .unwrap_or_else(|| root.to_path_buf());
    if !search_root.is_dir() || !search_root.starts_with(root) {
        return Err(PortcoveError::verification(
            "declared runtime directory is missing or escaped the install",
        ));
    }
    refuse_symlink_path_within(root, &search_root, "declared runtime directory")?;
    resolve_executable_hints(
        &search_root,
        qualification.platform,
        &qualification.executable_hints,
        "declared executable",
    )
}

pub(crate) fn resolve_executable_hints(
    search_root: &Path,
    platform: Platform,
    hints: &[String],
    label: &str,
) -> Result<PathBuf> {
    if !search_root.is_dir() {
        return Err(PortcoveError::verification(format!(
            "{label} search root is missing"
        )));
    }
    let mut files = walk_files(search_root)?;
    files.sort();
    for hint in hints {
        crate::archive::validate_relative_path(hint, false).map_err(|_| {
            PortcoveError::verification(format!("{label} hint is not a safe relative path"))
                .detail("hint", hint)
        })?;
        let path_aware = hint.contains('/');
        let mut matches = files
            .iter()
            .filter(|path| {
                if path_aware {
                    manifest_relative(search_root, path)
                        .is_ok_and(|relative| relative.eq_ignore_ascii_case(hint))
                } else {
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name.eq_ignore_ascii_case(hint))
                }
            })
            .cloned()
            .collect::<Vec<_>>();
        if matches.len() > 1 {
            matches.sort();
            let candidates = matches
                .iter()
                .map(|path| manifest_relative(search_root, path))
                .collect::<Result<Vec<_>>>()?;
            return Err(
                PortcoveError::conflict(format!("{label} hint is ambiguous"))
                    .detail("hint", hint)
                    .detail("candidates", candidates.join(", ")),
            );
        }
        if let Some(found) = matches.pop() {
            crate::permissions::require_platform_executable(&found, platform, label)?;
            return Ok(found);
        }
    }
    Err(PortcoveError::verification(format!(
        "none of the {label} hints for {platform:?} were found"
    )))
}

fn manifest_relative(root: &Path, path: &Path) -> Result<String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| PortcoveError::verification("manifest path escaped install root"))?;
    let value = relative
        .to_str()
        .ok_or_else(|| PortcoveError::verification("manifest paths must be valid Unicode"))?;
    if value.is_empty() || value.split(['/', '\\']).any(|component| component == "..") {
        return Err(PortcoveError::verification(
            "manifest contains an unsafe path",
        ));
    }
    Ok(value.replace('\\', "/"))
}

fn full_immutable_integrity(
    manifest: &InstallManifest,
    install: &InstallRecord,
    fallback: bool,
) -> Result<bool> {
    let staged_source = match &manifest.retained_contract {
        Some(contract) => {
            matches!(
                contract
                    .catalog(&install.port_id)?
                    .port(&install.port_id)?
                    .adapter,
                AdapterKind::StagedSourcePortable | AdapterKind::NativePortable
            )
        }
        None => fallback,
    };
    if staged_source {
        return Ok(true);
    }
    // Historical manifests did not mark nested executable companions critical.
    // Classify from authenticated members, never today's filesystem or mutable
    // projection: a deleted helper must not turn off complete verification.
    let selected = Path::new(&manifest.selected_executable);
    let platform = manifest.platform.unwrap_or(Platform::current()?);
    Ok(manifest.files.iter().any(|file| {
        let path = Path::new(&file.path);
        path.parent() != selected.parent()
            && (file.executable || is_executable_companion_name(path, platform))
            && !manifest.mutable_paths.iter().any(|mutable| {
                file.path == *mutable || file.path.starts_with(&format!("{mutable}/"))
            })
            && !manifest
                .mutable_file_patterns
                .iter()
                .any(|pattern| pattern.matches(&file.path))
    }))
}

fn refuse_staged_redirect(path: &Path, metadata: &fs::Metadata) -> Result<()> {
    #[cfg(windows)]
    let redirected = {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes()
            & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
            != 0
    };
    #[cfg(not(windows))]
    let redirected = metadata.file_type().is_symlink();
    if redirected
        || metadata.file_type().is_symlink()
        || (!metadata.is_file() && !metadata.is_dir())
    {
        return Err(PortcoveError::verification(
            "staged-source install contains a redirect or unsafe object",
        )
        .detail("path", path.display().to_string()));
    }
    Ok(())
}

fn require_staged_path(root: &Path, path: &Path) -> Result<()> {
    for candidate in path
        .ancestors()
        .take_while(|candidate| candidate.starts_with(root))
    {
        match fs::symlink_metadata(candidate) {
            Ok(metadata) => refuse_staged_redirect(candidate, &metadata)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

/// Unlike the legacy inventory walker, this never skips a redirected member.
/// Bound directories as well as files, and feed this one inventory to verification.
fn staged_install_files(root: &Path) -> Result<Vec<PathBuf>> {
    require_staged_path(root, root)?;
    let mut pending = vec![(root.to_owned(), 0_usize)];
    let mut files = Vec::new();
    let mut entries = 0_usize;
    while let Some((directory, depth)) = pending.pop() {
        if depth > 64 {
            return Err(PortcoveError::verification(
                "staged-source install exceeds traversal depth",
            ));
        }
        require_staged_path(root, &directory)?;
        for entry in fs::read_dir(&directory)? {
            entries += 1;
            if entries > 100_000 {
                return Err(PortcoveError::verification(
                    "staged-source install exceeds entry budget",
                ));
            }
            let path = entry?.path();
            let metadata = fs::symlink_metadata(&path)?;
            refuse_staged_redirect(&path, &metadata)?;
            if metadata.is_dir() {
                pending.push((path, depth + 1));
            } else {
                files.push(path);
            }
        }
    }
    Ok(files)
}

fn require_optional_mutable_file(path: &Path) -> Result<()> {
    // Unlike a best-effort existence probe, an inaccessible ancestor is not
    // evidence of an absent file. Check every existing ancestor before opening.
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) => {
                #[cfg(windows)]
                let reparse = {
                    use std::os::windows::fs::MetadataExt;
                    metadata.file_attributes()
                        & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
                        != 0
                };
                #[cfg(not(windows))]
                let reparse = false;
                if metadata.file_type().is_symlink() || reparse {
                    return Err(PortcoveError::verification(
                        "compatibility runtime file has a linked ancestor; preserve it and review the conflict",
                    ).detail("path", path.display().to_string()));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
        Ok(metadata) if metadata.is_file() => {
            // Reuse the no-follow/single-link handle check without reading any
            // payload. A mutable data leaf cannot alias another file.
            drop(crate::external_runtime::open_single_link_file(path)?);
            Ok(())
        }
        Ok(_) => Err(PortcoveError::verification(
            "compatibility runtime file is not a regular file; preserve it and review the conflict",
        )
        .detail("path", path.display().to_string())),
    }
}

fn is_regular_file_without_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
}

fn refuse_symlink_path_within(root: &Path, path: &Path, label: &str) -> Result<()> {
    for candidate in path
        .ancestors()
        .take_while(|candidate| candidate.starts_with(root))
    {
        if fs::symlink_metadata(candidate).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
            return Err(PortcoveError::verification(format!(
                "{label} traverses a symlink inside the install"
            ))
            .detail("path", candidate.display().to_string()));
        }
    }
    Ok(())
}

fn manifest_path_is_mutable(manifest: &InstallManifest, relative: &str) -> bool {
    manifest
        .mutable_file_patterns
        .iter()
        .any(|pattern| pattern.matches(relative))
        || manifest
            .mutable_paths
            .iter()
            .any(|mutable| relative == mutable || relative.starts_with(&format!("{mutable}/")))
}

fn mutable_file_pattern_failures(
    install_root: &Path,
    manifest: &InstallManifest,
) -> Result<Vec<String>> {
    let selected = install_root.join(&manifest.selected_executable);
    let platform = manifest.platform.unwrap_or(Platform::current()?);
    let mut failures = std::collections::BTreeSet::new();
    for pattern in &manifest.mutable_file_patterns {
        let directory = pattern
            .directory
            .as_deref()
            .map(|relative| manifest_member(install_root, relative))
            .transpose()?
            .unwrap_or_else(|| install_root.to_path_buf());
        refuse_symlink_path_within(install_root, &directory, "mutable file pattern directory")?;
        let entries = match fs::read_dir(&directory) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            result => result?,
        };
        for entry in entries {
            let entry = entry?;
            let name = crate::path::unicode(Path::new(&entry.file_name()), "mutable filename")?;
            if !pattern.pattern.matches(&name) {
                continue;
            }
            let candidate = entry.path();
            let relative = manifest_relative(install_root, &candidate)?;
            let file_type = entry.file_type()?;
            if file_type.is_symlink() || !file_type.is_file() {
                failures.insert(format!("invalid mutable-pattern entry: {relative}"));
            } else if is_executable_companion(&candidate, &selected, platform)? {
                failures.insert(format!("unexpected launch-sensitive file: {relative}"));
            }
        }
    }
    Ok(failures.into_iter().collect())
}

fn is_critical_companion(path: &Path, selected: &Path, platform: Platform) -> Result<bool> {
    if path.parent() != selected.parent() {
        return Ok(false);
    }
    if is_critical_companion_name(path, platform) {
        return Ok(true);
    }
    Ok(matches!(
        platform,
        Platform::LinuxX86_64 | Platform::MacosX86_64 | Platform::MacosAarch64
    ) && crate::permissions::executable_intent(path)?)
}

fn is_executable_companion(path: &Path, selected: &Path, platform: Platform) -> Result<bool> {
    if path.parent() != selected.parent() {
        return Ok(false);
    }
    is_executable_member(path, platform)
}

fn is_executable_member(path: &Path, platform: Platform) -> Result<bool> {
    if is_executable_companion_name(path, platform) {
        return Ok(true);
    }
    Ok(matches!(
        platform,
        Platform::LinuxX86_64 | Platform::MacosX86_64 | Platform::MacosAarch64
    ) && crate::permissions::executable_intent(path)?)
}

fn is_critical_companion_name(path: &Path, platform: Platform) -> bool {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase);
    is_executable_companion_name(path, platform)
        || matches!(extension.as_deref(), Some("toml" | "ini" | "cfg"))
}

fn is_executable_companion_name(path: &Path, platform: Platform) -> bool {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase);
    matches!(
        extension.as_deref(),
        Some("dll" | "so" | "dylib" | "bat" | "cmd" | "ps1" | "sh")
    ) || name.contains(".so.")
        || (platform == Platform::WindowsX86_64 && extension.as_deref() == Some("exe"))
}

fn extract_asset(
    source: &Path,
    destination: &Path,
    asset_name: &str,
    expected_size: u64,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<()> {
    let lower = asset_name.to_ascii_lowercase();
    if lower.ends_with(".zip") || lower.ends_with(".tar.gz") || lower.ends_with(".tgz") {
        extract_archive_with_checkpoint(source, destination, asset_name, expected_size, checkpoint)
    } else if lower.ends_with(".exe") || lower.ends_with(".appimage") {
        crate::archive::validate_relative_path(asset_name, false)?;
        let target = destination.join(asset_name);
        fs::copy(source, &target)?;
        crate::permissions::normalize_archive_entry(&target, false, true)?;
        Ok(())
    } else {
        Err(PortcoveError::unsupported(format!(
            "unsupported package format: {asset_name}"
        )))
    }
}

fn normalize_standalone_appimage(
    root: &Path,
    artifact: &ArtifactIdentity,
    qualification: &InstallQualification,
) -> Result<()> {
    if qualification.platform != Platform::LinuxX86_64
        || !artifact
            .asset_name
            .to_ascii_lowercase()
            .ends_with(".appimage")
        || qualification.runtime_subdirectory.is_some()
    {
        return Ok(());
    }
    let [hint] = qualification.executable_hints.as_slice() else {
        return Ok(());
    };
    crate::archive::validate_relative_path(hint, false)?;
    crate::archive::validate_relative_path(&artifact.asset_name, false)?;
    if hint.contains(['/', '\\'])
        || !hint.to_ascii_lowercase().ends_with(".appimage")
        || hint.eq_ignore_ascii_case(&artifact.asset_name)
    {
        return Ok(());
    }
    let source = root.join(&artifact.asset_name);
    refuse_symlink_path_within(root, &source, "standalone AppImage")?;
    crate::permissions::require_platform_executable(
        &source,
        qualification.platform,
        "standalone AppImage",
    )?;
    crate::durability::rename_noreplace(&source, &root.join(hint))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{
        fs::File,
        sync::{
            Mutex,
            atomic::{AtomicBool, Ordering},
        },
    };

    use sha2::{Digest, Sha256};

    use super::*;

    #[tokio::test]
    async fn uppercase_racewave_without_policy_refuses_before_contact_or_staging() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        server.set_nonblocking(true).unwrap();
        let output = library.versions_dir().join("sample");
        let installer = Installer::with_network_bounds(
            library.clone(),
            Duration::from_millis(200),
            Duration::from_millis(200),
        )
        .unwrap();
        let request = InstallRequest {
            port_id: "sample".into(),
            output_root: output.clone(),
            activate: false,
            managed: None,
            qualification: InstallQualification::test("game.exe"),
            release: ResolvedRelease {
                version: "v1.0.0".into(),
                channel: crate::ReleaseChannel::Stable,
                published_at: None,
                asset: crate::ReleaseAsset {
                    name: "RaceWave46-Windows-x64-v1.0.0.zip".into(),
                    size: 35_768_574,
                    sha256: "f77f3cc10f2dc3db56992480b6906b48bfa1fd1ef614818d039ae86293135028"
                        .to_uppercase(),
                    url: format!("http://{}/runtime.zip", server.local_addr().unwrap()),
                },
            },
        };
        let failure = installer
            .install(
                request,
                &OperationCoordinator::new("uppercase-credential-fence", None),
                |_| {},
            )
            .await
            .unwrap_err();
        assert!(
            failure.message.contains("actual reviewed RaceWave46"),
            "{failure}"
        );
        assert_eq!(
            server.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        assert!(!output.exists());
        assert!(library.all_installs().unwrap().is_empty());
        assert_eq!(fs::read_dir(library.staging_dir()).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn uppercase_regaiden_without_acceptance_refuses_before_contact_or_staging() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        server.set_nonblocking(true).unwrap();
        let output = library.versions_dir().join("sample");
        let request = InstallRequest {
            port_id: "sample".into(),
            output_root: output.clone(),
            activate: false,
            managed: None,
            qualification: InstallQualification::test("game.exe"),
            release: ResolvedRelease {
                version: "v0.4.1".into(),
                channel: crate::ReleaseChannel::Stable,
                published_at: None,
                asset: crate::ReleaseAsset {
                    name: "Resident_Evil_Gaiden_Recomp_v0.4.1_Windows.zip".into(),
                    size: 33_085_815,
                    sha256: crate::managed_shared_preferences::SHA.to_uppercase(),
                    url: format!("http://{}/runtime.zip", server.local_addr().unwrap()),
                },
            },
        };
        let installer = Installer::with_network_bounds(
            library.clone(),
            Duration::from_millis(200),
            Duration::from_millis(200),
        )
        .unwrap();
        let failure = installer
            .install(
                request,
                &OperationCoordinator::new("uppercase-shared-fence", None),
                |_| {},
            )
            .await
            .unwrap_err();
        assert!(failure.message.contains("reviewed ReGaiden"), "{failure}");
        assert_eq!(
            server.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        assert!(!output.exists());
        assert!(library.all_installs().unwrap().is_empty());
        assert_eq!(fs::read_dir(library.staging_dir()).unwrap().count(), 0);
    }

    #[cfg(windows)]
    #[test]
    fn retained_shared_scope_distinguishes_inspection_failure_from_account_change() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let catalog = crate::Catalog::embedded().unwrap();
        let id = "resident-evil-gaiden-recomp";
        let port = catalog.port(id).unwrap();
        let root = library
            .versions_dir()
            .join(id)
            .join(crate::managed_shared_preferences::SHA);
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("Resident_Evil_Gaiden__USA_.exe"),
            b"synthetic manifest fixture, never executed",
        )
        .unwrap();
        let scope = crate::managed_shared_preferences::review(port, &root)
            .unwrap()
            .unwrap();
        let mut qualification =
            InstallQualification::from_catalog(&catalog, id, Platform::WindowsX86_64)
                .unwrap()
                .with_shared_preferences(
                    Some(crate::managed_shared_preferences::Acceptance::after_review(
                        &scope,
                    )),
                    &root,
                )
                .unwrap();
        let artifact = ArtifactIdentity {
            asset_name: "Resident_Evil_Gaiden_Recomp_v0.4.1_Windows.zip".into(),
            size: 33_085_815,
            sha256: crate::managed_shared_preferences::SHA.into(),
        };
        let (manifest_sha256, selected_executable, runtime) = write_manifest(
            "shared-fixture",
            id,
            "v0.4.1",
            &artifact,
            &qualification,
            &root,
        )
        .unwrap();
        let mut install = InstallRecord {
            id: "shared-fixture".into(),
            port_id: id.into(),
            version: "v0.4.1".into(),
            path: root.clone(),
            channel: crate::ReleaseChannel::Stable,
            installed_at: 1,
            verified: true,
            staged: false,
            artifact: artifact.clone(),
            manifest_sha256,
            selected_executable,
            runtime,
        };
        library.register_install(&install, true).unwrap();
        let service = crate::PortcoveService::new(library.clone()).unwrap();
        assert!(
            verified_manifest(&install)
                .unwrap()
                .shared_preferences
                .is_some()
        );
        assert_eq!(verified_manifest(&install).unwrap().schema_version, 7);
        assert!(crate::install::portability_catalog_for_install(&install, &catalog).is_err());
        assert!(
            !service
                .status(id)
                .unwrap()
                .readiness
                .unwrap()
                .blockers
                .contains(&crate::LaunchBlocker::SharedPreferencesReviewRequired)
        );
        fs::create_dir(root.join("runtime_prefs.ini")).unwrap();
        let blockers = service.status(id).unwrap().readiness.unwrap().blockers;
        assert!(blockers.contains(&crate::LaunchBlocker::SharedPreferencesUnavailable));
        assert!(!blockers.contains(&crate::LaunchBlocker::SharedPreferencesReviewRequired));
        fs::remove_dir(root.join("runtime_prefs.ini")).unwrap();
        // Model a retained manifest from another account without changing host
        // identity, global preferences or production authorization machinery.
        let mut changed = scope;
        changed.binding.account_sid_sha256 = "0".repeat(64);
        qualification.shared_preferences = Some(
            crate::managed_shared_preferences::Acceptance::after_review(&changed),
        );
        let (digest, _, _) = write_manifest(
            "shared-fixture",
            id,
            "v0.4.1",
            &artifact,
            &qualification,
            &root,
        )
        .unwrap();
        install.manifest_sha256 = digest;
        library.register_install(&install, true).unwrap();
        let blockers = service.status(id).unwrap().readiness.unwrap().blockers;
        assert!(blockers.contains(&crate::LaunchBlocker::SharedPreferencesReviewRequired));
        assert!(!blockers.contains(&crate::LaunchBlocker::SharedPreferencesUnavailable));
        assert!(
            service
                .require_installed_shared_preferences(&install)
                .is_err()
        );
        assert!(root.is_dir());
        // Synthetic launch marker exercises the real keep-data removal path;
        // no game, account identity or global preferences are changed here.
        fs::create_dir_all(root.join("saves")).unwrap();
        fs::write(
            root.join("saves/recovery-probe.bin"),
            b"local recovery data",
        )
        .unwrap();
        fs::write(root.join(".portcove-launched"), b"synthetic test marker").unwrap();
        let preview = service.preview_removal(id).unwrap();
        assert!(preview.persistent_data_will_be_preserved);
        let authorization = service
            .authorize_removal(id, &preview.preview_sha256)
            .unwrap();
        service.remove(id, &authorization.token).unwrap();
        assert!(!root.exists());
        assert_eq!(
            fs::read(library.user_dir(id).join("saves/recovery-probe.bin")).unwrap(),
            b"local recovery data"
        );
        assert!(library.all_installs().unwrap().is_empty());
    }

    #[tokio::test]
    async fn managed_worker_completion_storage_error_keeps_both_proofs_false() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let operation = OperationCoordinator::new("owned-managed-worker", None);
        let staging = library.staging_dir().join(operation.operation_id());
        fs::create_dir_all(&staging).unwrap();
        fs::write(staging.join("owned-input"), b"retained bytes").unwrap();
        let mut record = LifecycleOperation::new(
            operation.operation_id(),
            LifecycleOperationKind::Install,
            "sample",
        );
        record.paths.staging = Some(staging.clone());
        let store = OperationStore::new(library.clone());
        store.put(&mut record).unwrap();
        crate::database::connect(library.root()).unwrap().execute_batch(
            "CREATE TRIGGER owned_completion_failure BEFORE UPDATE ON lifecycle_operations WHEN NEW.preparation_process_quiesced=1 BEGIN SELECT RAISE(ABORT, 'owned completion persistence failure'); END;"
        ).unwrap();
        let mut lifecycle = InstallLifecycle {
            destination: staging.join("unused"),
            operation_root: staging.clone(),
            store: store.clone(),
            record,
        };
        let error = run_managed_install_worker(&mut lifecycle, &operation, |_| (Ok(()), true))
            .await
            .unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::State);
        assert!(
            error
                .message
                .contains("owned completion persistence failure")
        );
        assert_eq!(lifecycle.record.preparation_process_quiesced, Some(false));
        assert_eq!(
            store
                .get(operation.operation_id())
                .unwrap()
                .unwrap()
                .preparation_process_quiesced,
            Some(false)
        );
        assert!(crate::cancellation::discard_private_install(&library, &lifecycle.record).is_err());
        assert!(staging.join("owned-input").is_file());
        assert!(store.get(operation.operation_id()).unwrap().is_some());
    }

    #[tokio::test]
    async fn managed_worker_failure_and_panic_retain_tree_and_journal() {
        for panic in [false, true] {
            let temporary = tempfile::tempdir().unwrap();
            let library = Library::open(temporary.path().join("library")).unwrap();
            let operation = OperationCoordinator::new("owned-managed-worker", None);
            let mut record = LifecycleOperation::new(
                operation.operation_id(),
                LifecycleOperationKind::Install,
                "sample",
            );
            let staging = library.staging_dir().join(operation.operation_id());
            fs::create_dir_all(&staging).unwrap();
            record.paths.staging = Some(staging.clone());
            let store = OperationStore::new(library.clone());
            store.put(&mut record).unwrap();
            let mut lifecycle = InstallLifecycle {
                destination: staging.join("unused"),
                operation_root: staging.clone(),
                store: store.clone(),
                record,
            };
            let worker_store = store.clone();
            let worker_staging = staging.clone();
            let result =
                run_managed_install_worker(&mut lifecycle, &operation, move |checkpoint| {
                    assert_eq!(
                        worker_store
                            .get(checkpoint.operation_id())
                            .unwrap()
                            .unwrap()
                            .preparation_process_quiesced,
                        Some(false)
                    );
                    fs::write(
                        worker_staging.join("owned-worker-input"),
                        b"retained private bytes",
                    )
                    .unwrap();
                    if panic {
                        panic!("owned managed worker panic");
                    }
                    (
                        Err(PortcoveError::install("owned managed worker failed")),
                        false,
                    )
                })
                .await;
            assert_eq!(result.unwrap_err().code, crate::ErrorCode::Install);
            assert_eq!(lifecycle.record.preparation_process_quiesced, Some(false));
            assert_eq!(
                store
                    .get(operation.operation_id())
                    .unwrap()
                    .unwrap()
                    .preparation_process_quiesced,
                Some(false)
            );
            let hold = crate::cancellation::discard_private_install(&library, &lifecycle.record)
                .unwrap_err();
            assert_eq!(
                hold.details.get("cleanup_hold").map(String::as_str),
                Some("unproven_process_quiescence")
            );
            assert_eq!(
                fs::read(staging.join("owned-worker-input")).unwrap(),
                b"retained private bytes"
            );
            assert!(store.get(operation.operation_id()).unwrap().is_some());
        }
    }

    #[tokio::test]
    async fn managed_worker_is_joined_before_cancellation_cleanup_and_syncs_proof() {
        for quiesced in [false, true] {
            let temporary = tempfile::tempdir().unwrap();
            let library = Library::open(temporary.path().join("library")).unwrap();
            let service = crate::PortcoveService::new(library.clone()).unwrap();
            let (activity, operation) = service
                .begin_cancellable_activity(
                    crate::ActivityOperation::Install,
                    crate::ActivityTargetKind::Port,
                    Some("sample"),
                )
                .unwrap();
            let staging = library.staging_dir().join(&activity.id);
            fs::create_dir_all(&staging).unwrap();
            fs::write(staging.join("owned-input"), b"keep while worker lives").unwrap();
            let mut record =
                LifecycleOperation::new(&activity.id, LifecycleOperationKind::Install, "sample");
            record.paths.staging = Some(staging.clone());
            let store = OperationStore::new(library.clone());
            store.put(&mut record).unwrap();
            let mut lifecycle = InstallLifecycle {
                destination: staging.join("unused"),
                operation_root: staging.clone(),
                store: store.clone(),
                record,
            };
            let latch = Arc::new((Mutex::new((false, false)), std::sync::Condvar::new()));
            let worker_latch = latch.clone();
            let id = activity.id.clone();
            let pending = tokio::spawn(async move {
                let result =
                    run_managed_install_worker(&mut lifecycle, &operation, move |checkpoint| {
                        let (lock, condition) = &*worker_latch;
                        let mut state = lock.lock().unwrap();
                        state.0 = true;
                        condition.notify_all();
                        while !state.1 {
                            state = condition.wait(state).unwrap();
                        }
                        (checkpoint.checkpoint(), quiesced)
                    })
                    .await;
                (lifecycle, result)
            });
            tokio::time::timeout(Duration::from_secs(5), async {
                while !latch.0.lock().unwrap().0 {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .unwrap();
            service.request_cancellation(&id).unwrap();
            let finished_early = pending.is_finished();
            let durable_before_join = store
                .get(&id)
                .unwrap()
                .unwrap()
                .preparation_process_quiesced;
            let staging_before_join = staging.is_dir();
            {
                let (lock, condition) = &*latch;
                lock.lock().unwrap().1 = true;
                condition.notify_all();
            }
            let (lifecycle, result) = pending.await.unwrap();
            assert!(!finished_early);
            assert_eq!(durable_before_join, Some(false));
            assert!(staging_before_join);
            assert_eq!(result.unwrap_err().code, crate::ErrorCode::Cancelled);
            assert_eq!(
                lifecycle.record.preparation_process_quiesced,
                Some(quiesced)
            );
            assert_eq!(
                store
                    .get(&id)
                    .unwrap()
                    .unwrap()
                    .preparation_process_quiesced,
                Some(quiesced)
            );
            let cleanup = crate::cancellation::discard_private_install(&library, &lifecycle.record);
            assert_eq!(cleanup.is_ok(), quiesced);
            assert_eq!(staging.exists(), !quiesced);
            assert_eq!(store.get(&id).unwrap().is_some(), !quiesced);
        }
    }

    #[test]
    fn retired_cartridge_creation_is_refused_at_install_admission() {
        let catalog = crate::cartridge_build::tests::fixture_catalog();
        let qualification = InstallQualification::from_catalog(
            &catalog,
            "yoshis-cookie-recomp",
            Platform::WindowsX86_64,
        )
        .unwrap();
        assert_eq!(
            qualification.require_runtime_creation().unwrap_err().code,
            crate::ErrorCode::Unsupported
        );
        assert!(qualification.with_cartridge_build_source(None).is_err());
        InstallQualification::test("game.exe")
            .require_runtime_creation()
            .unwrap();
    }

    #[test]
    fn cartridge_retained_manifest_preserves_only_declared_data_and_refuses_debug_listener() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("payload");
        fs::create_dir(&root).unwrap();
        for name in [
            "YoshisCookieRecomp.exe",
            "SDL2.dll",
            "libc++.dll",
            "libunwind.dll",
            "game.nes",
            crate::cartridge_build::RECEIPT,
        ] {
            fs::write(root.join(name), format!("inert fixture {name}")).unwrap();
        }
        let catalog = crate::cartridge_build::tests::fixture_catalog();
        let qualification = InstallQualification::from_catalog(
            &catalog,
            "yoshis-cookie-recomp",
            Platform::WindowsX86_64,
        )
        .unwrap();
        let (installer, install) = create_test_install(&root, &qualification);
        fs::create_dir(root.join("saves")).unwrap();
        for name in [
            "config.ini",
            "config.ini.tmp",
            "cyc_shot_0000.png",
            "saves/game.cycstate",
            "saves/game.cycstate.tmp",
        ] {
            fs::write(root.join(name), b"private user data fixture").unwrap();
        }
        installer.verify_critical(&install, &qualification).unwrap();
        for name in ["debug.ini", "rom.cfg"] {
            fs::write(root.join(name), b"undeclared control").unwrap();
            let error = installer
                .verify_critical(&install, &qualification)
                .unwrap_err();
            assert!(error.details["failures"].contains(name));
            fs::remove_file(root.join(name)).unwrap();
        }
        for name in [
            "game.nes",
            crate::cartridge_build::RECEIPT,
            "libc++.dll",
            "YoshisCookieRecomp.exe",
        ] {
            let prior = fs::read(root.join(name)).unwrap();
            fs::write(root.join(name), b"tampered protected fixture").unwrap();
            assert!(
                installer.verify_critical(&install, &qualification).is_err(),
                "{name}"
            );
            fs::write(root.join(name), prior).unwrap();
        }
        let retained = installer.retained_catalog(&install).unwrap().unwrap();
        assert_eq!(
            retained
                .port(&install.port_id)
                .unwrap()
                .release
                .managed_build,
            catalog
                .port(&install.port_id)
                .unwrap()
                .release
                .managed_build
        );
        installer.verify_critical(&install, &qualification).unwrap();
    }

    fn create_test_install(
        root: &Path,
        qualification: &InstallQualification,
    ) -> (Installer, InstallRecord) {
        let library = Library::open(root.parent().unwrap().join("library")).unwrap();
        let installer = Installer::new(library).unwrap();
        let artifact = ArtifactIdentity {
            asset_name: "fixture.zip".into(),
            sha256: "a".repeat(64),
            size: 32,
        };
        let port_id = qualification.retained_contract.as_ref().unwrap().port_id();
        let (manifest_sha256, selected_executable, runtime) = write_manifest(
            "test-install",
            port_id,
            "v1",
            &artifact,
            qualification,
            root,
        )
        .unwrap();
        (
            installer,
            InstallRecord {
                id: "test-install".into(),
                port_id: port_id.into(),
                version: "v1".into(),
                path: root.to_path_buf(),
                channel: crate::ReleaseChannel::Stable,
                installed_at: 1,
                verified: true,
                staged: false,
                artifact,
                runtime,
                manifest_sha256,
                selected_executable,
            },
        )
    }

    fn nested_executable_integrity_fixture() -> (
        tempfile::TempDir,
        Installer,
        InstallRecord,
        InstallQualification,
        PathBuf,
    ) {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("payload");
        let helpers = root.join("package/libexec/dkr-r");
        fs::create_dir_all(&helpers).unwrap();
        fs::write(root.join("package/DKR-R.exe"), b"inert main").unwrap();
        fs::write(helpers.join("DKR-R-InputHost.exe"), b"reviewed helper").unwrap();
        fs::write(helpers.join("SDL3.dll"), b"reviewed library").unwrap();
        fs::write(helpers.join("notice.txt"), b"reviewed notice").unwrap();
        let retained =
            crate::Catalog::from_json(include_str!("../catalog/catalog-schema1-fixture.json"))
                .unwrap();
        let qualification =
            InstallQualification::from_catalog(&retained, "dkr-r", Platform::WindowsX86_64)
                .unwrap();
        let (installer, install) = create_test_install(&root, &qualification);
        (temporary, installer, install, qualification, helpers)
    }

    #[test]
    fn nested_executable_integrity_checks_old_noncritical_helpers() {
        let (_temporary, installer, install, qualification, helpers) =
            nested_executable_integrity_fixture();
        let manifest = verified_manifest(&install).unwrap();
        assert!(
            manifest
                .files
                .iter()
                .any(|file| { file.path.ends_with("DKR-R-InputHost.exe") && !file.critical })
        );
        installer.verify_critical(&install, &qualification).unwrap();
        for (name, original) in [
            ("DKR-R-InputHost.exe", b"reviewed helper".as_slice()),
            ("SDL3.dll", b"reviewed library".as_slice()),
        ] {
            let target = helpers.join(name);
            fs::write(&target, b"changed").unwrap();
            assert!(installer.verify_critical(&install, &qualification).is_err());
            let mut broadened = qualification.clone();
            broadened
                .runtime_mutable_paths
                .push("package/libexec".into());
            assert!(installer.verify_critical(&install, &broadened).is_err());
            fs::remove_file(&target).unwrap();
            assert!(installer.verify_critical(&install, &qualification).is_err());
            fs::write(&target, original).unwrap();
        }
        installer.verify_critical(&install, &qualification).unwrap();
    }

    #[test]
    fn nested_executable_integrity_refuses_new_files_but_preserves_retained_mutability() {
        let (_temporary, installer, install, qualification, helpers) =
            nested_executable_integrity_fixture();
        let mutable = install.path.join("dkr-runtime-data");
        fs::create_dir_all(&mutable).unwrap();
        fs::write(mutable.join("player-save.bin"), b"player data").unwrap();
        installer.verify_critical(&install, &qualification).unwrap();
        for name in ["unknown.exe", "unknown.dll", "unknown.txt"] {
            let target = helpers.join(name);
            fs::write(&target, b"unadmitted").unwrap();
            assert!(installer.verify_critical(&install, &qualification).is_err());
            if name != "unknown.txt" {
                let mut broadened = qualification.clone();
                broadened
                    .runtime_mutable_paths
                    .push("package/libexec".into());
                assert!(installer.verify_critical(&install, &broadened).is_err());
            }
            fs::remove_file(target).unwrap();
        }
        assert_eq!(
            fs::read(mutable.join("player-save.bin")).unwrap(),
            b"player data"
        );
        installer.verify_critical(&install, &qualification).unwrap();
    }

    #[cfg(any(windows, unix))]
    #[test]
    fn nested_executable_integrity_refuses_identical_redirected_parent() {
        let (temporary, installer, install, qualification, helpers) =
            nested_executable_integrity_fixture();
        let outside = temporary.path().join("outside");
        fs::create_dir(&outside).unwrap();
        for name in ["DKR-R-InputHost.exe", "SDL3.dll", "notice.txt"] {
            fs::copy(helpers.join(name), outside.join(name)).unwrap();
            fs::remove_file(helpers.join(name)).unwrap();
        }
        fs::remove_dir(&helpers).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &helpers).unwrap();
        #[cfg(windows)]
        {
            for path in [&helpers, &outside] {
                assert!(
                    !path
                        .to_str()
                        .unwrap()
                        .contains(['"', '%', '!', '&', '|', '<', '>', '^', '\r', '\n'])
                );
            }
            let mut command = crate::ChildProcessPolicy::native_tool_spec(
                crate::ChildProcessClass::HostTool,
                "cmd.exe",
            )
            .unwrap();
            command.raw_arg(format!(
                "/D /V:OFF /C mklink /J \"{}\" \"{}\"",
                helpers.display(),
                outside.display()
            ));
            let started = std::time::Instant::now();
            let mut final_capture = None;
            let result = crate::tool_process::run_tool(
                &mut command,
                &|| {
                    if started.elapsed() >= std::time::Duration::from_secs(2) {
                        Err(PortcoveError::state(
                            "nested helper junction fixture exceeded two seconds",
                        ))
                    } else {
                        Ok(())
                    }
                },
                crate::tool_process::ToolProcessObserver {
                    diagnostics: Some(crate::tool_process::ToolDiagnosticSink {
                        activity_id: "helper-junction-fixture",
                        phase: "fixture.junction",
                        record: &mut |capture| {
                            final_capture = Some(capture.clone());
                            Ok(())
                        },
                    }),
                    quiesced: None,
                },
            )
            .unwrap();
            assert!(result.status.success(), "{}", result.output);
            let captured = final_capture.unwrap();
            assert!(captured.complete && !captured.stdout.truncated && !captured.stderr.truncated);
            assert_eq!(
                captured.stdout.text.len() + 1 + captured.stderr.text.len(),
                result.output.len()
            );
        }
        assert_eq!(
            fs::read(helpers.join("SDL3.dll")).unwrap(),
            b"reviewed library"
        );
        assert!(installer.verify_critical(&install, &qualification).is_err());
        assert_eq!(
            fs::read(outside.join("SDL3.dll")).unwrap(),
            b"reviewed library"
        );
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 3);
        #[cfg(windows)]
        fs::remove_dir(&helpers).unwrap();
        #[cfg(unix)]
        fs::remove_file(&helpers).unwrap();
    }

    fn staged_integrity_fixture() -> (
        tempfile::TempDir,
        Installer,
        InstallRecord,
        InstallQualification,
        PathBuf,
    ) {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("payload");
        let manifest = root
            .join("mods/preloaded/packages/megaman-x2.enhancement.widescreen/1.0.0/manifest.toml");
        fs::create_dir_all(manifest.parent().unwrap()).unwrap();
        fs::write(
            root.join("MegaManX2SNESRecomp.exe"),
            b"inert executable fixture",
        )
        .unwrap();
        fs::write(&manifest, b"reviewed").unwrap();
        let catalog = crate::Catalog::embedded().unwrap();
        let qualification = InstallQualification::from_catalog(
            &catalog,
            "mega-man-x2-snes-recomp",
            Platform::WindowsX86_64,
        )
        .unwrap();
        let (installer, install) = create_test_install(&root, &qualification);
        (temporary, installer, install, qualification, manifest)
    }

    #[test]
    fn staged_integrity_checks_nested_noncritical_members_and_unknown_files() {
        let (_temporary, installer, install, qualification, target) = staged_integrity_fixture();
        let manifest = verified_manifest(&install).unwrap();
        let member = manifest
            .files
            .iter()
            .find(|file| file.path.ends_with("manifest.toml"))
            .unwrap();
        assert!(
            !member.critical,
            "exercise already retained noncritical identity"
        );
        installer.verify_critical(&install, &qualification).unwrap();
        // Declared persistent/runtime output remains outside immutable identity.
        fs::write(install.path.join("config.ini"), b"player settings").unwrap();
        fs::write(install.path.join("last_run_report.json"), b"runtime output").unwrap();
        installer.verify_critical(&install, &qualification).unwrap();
        for replacement in [
            Some(b"tampered".as_slice()),
            Some(b"short".as_slice()),
            None,
        ] {
            match replacement {
                Some(bytes) => fs::write(&target, bytes).unwrap(),
                None => fs::remove_file(&target).unwrap(),
            }
            assert!(installer.verify_critical(&install, &qualification).is_err());
            // Neither an unrelated current projection nor additive mutability
            // can turn the retained immutable member into an unchecked file.
            let mut changed = InstallQualification::test("MegaManX2SNESRecomp.exe");
            changed.runtime_mutable_paths.push(member.path.clone());
            assert!(installer.verify_critical(&install, &changed).is_err());
            fs::write(&target, b"reviewed").unwrap();
        }
        let unexpected = target.parent().unwrap().join("unexpected.toml");
        fs::write(&unexpected, b"unreviewed selector").unwrap();
        assert!(installer.verify_critical(&install, &qualification).is_err());
        fs::remove_file(unexpected).unwrap();
        installer.verify_critical(&install, &qualification).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn staged_integrity_refuses_unknown_links_and_identical_redirected_parents() {
        let (temporary, installer, install, qualification, target) = staged_integrity_fixture();
        let outside = temporary.path().join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("manifest.toml"), b"reviewed").unwrap();
        let unknown = target.parent().unwrap().join("unknown-link");
        std::os::unix::fs::symlink(outside.join("manifest.toml"), &unknown).unwrap();
        assert!(installer.verify_critical(&install, &qualification).is_err());
        fs::remove_file(unknown).unwrap();
        let parent = target.parent().unwrap();
        fs::remove_file(&target).unwrap();
        fs::remove_dir(parent).unwrap();
        std::os::unix::fs::symlink(&outside, parent).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"reviewed");
        assert!(installer.verify_critical(&install, &qualification).is_err());
    }

    struct FailOnce {
        point: LifecycleFaultPoint,
        fired: AtomicBool,
    }

    struct FailWithMessage {
        point: LifecycleFaultPoint,
        message: &'static str,
    }

    struct FailSequence {
        points: Mutex<Vec<LifecycleFaultPoint>>,
    }

    #[test]
    fn standalone_appimage_versions_keep_artifact_identity_and_verified_manifests() {
        let temporary = tempfile::tempdir().unwrap();
        let port =
            crate::Catalog::from_json(include_str!("../catalog/catalog-schema1-fixture.json"))
                .unwrap()
                .port("dkr-r")
                .unwrap()
                .clone();
        let qualification =
            crate::test_fixture::retained_qualification(&port, Platform::LinuxX86_64).unwrap();
        let declared = Path::new("DKR-R-1.0.4-Linux-x86_64.AppImage");
        for version in ["1.0.4", "1.0.5"] {
            let root = temporary.path().join(version);
            fs::create_dir_all(&root).unwrap();
            let source = temporary.path().join(format!("{version}.download"));
            fs::write(&source, version).unwrap();
            let artifact = ArtifactIdentity {
                asset_name: format!("DKR-R-{version}-Linux-x86_64.AppImage"),
                sha256: hex::encode(Sha256::digest(version)),
                size: version.len() as u64,
            };
            extract_asset(&source, &root, &artifact.asset_name, artifact.size, &|| {
                Ok(())
            })
            .unwrap();
            normalize_standalone_appimage(&root, &artifact, &qualification).unwrap();
            if Path::new(&artifact.asset_name) != declared {
                assert!(!root.join(&artifact.asset_name).exists());
            }
            assert_eq!(fs::read(root.join(declared)).unwrap(), version.as_bytes());
            let (_, selected, _) =
                write_manifest(version, "dkr-r", version, &artifact, &qualification, &root)
                    .unwrap();
            assert_eq!(selected, declared);
            let manifest: InstallManifest =
                serde_json::from_slice(&fs::read(root.join(".portcove-manifest.json")).unwrap())
                    .unwrap();
            assert_eq!(manifest.artifact.asset_name, artifact.asset_name);
            assert_eq!(manifest.artifact.sha256, artifact.sha256);
        }
    }

    #[test]
    fn standalone_appimage_normalization_is_narrow_and_never_overwrites() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path();
        let mut qualification = InstallQualification::test("game.AppImage");
        qualification.platform = Platform::LinuxX86_64;
        let mut artifact = ArtifactIdentity {
            asset_name: "game-v2.AppImage".into(),
            sha256: "a".repeat(64),
            size: 7,
        };
        fs::write(root.join(&artifact.asset_name), b"payload").unwrap();
        crate::permissions::normalize_archive_entry(&root.join(&artifact.asset_name), false, true)
            .unwrap();
        fs::write(root.join("game.AppImage"), b"preserve").unwrap();
        assert!(normalize_standalone_appimage(root, &artifact, &qualification).is_err());
        assert_eq!(fs::read(root.join("game.AppImage")).unwrap(), b"preserve");
        assert_eq!(
            fs::read(root.join(&artifact.asset_name)).unwrap(),
            b"payload"
        );
        fs::remove_file(root.join("game.AppImage")).unwrap();

        for hints in [
            vec!["a.AppImage", "b.AppImage"],
            vec!["nested/game.AppImage"],
            vec!["game.exe"],
        ] {
            qualification.executable_hints = hints.into_iter().map(String::from).collect();
            normalize_standalone_appimage(root, &artifact, &qualification).unwrap();
            assert!(root.join(&artifact.asset_name).is_file());
            assert!(resolve_declared_executable(root, &qualification).is_err());
        }
        qualification.executable_hints = vec!["../escape.AppImage".into()];
        assert!(normalize_standalone_appimage(root, &artifact, &qualification).is_err());
        qualification.executable_hints = vec!["game.AppImage".into()];
        qualification.runtime_subdirectory = Some("nested".into());
        normalize_standalone_appimage(root, &artifact, &qualification).unwrap();
        qualification.runtime_subdirectory = None;
        qualification.platform = Platform::WindowsX86_64;
        normalize_standalone_appimage(root, &artifact, &qualification).unwrap();
        qualification.platform = Platform::LinuxX86_64;
        artifact.asset_name = "game.zip".into();
        normalize_standalone_appimage(root, &artifact, &qualification).unwrap();
        assert!(root.join("game-v2.AppImage").is_file());
        assert!(!root.join("game.AppImage").exists());
        assert!(
            extract_asset(
                &root.join("game-v2.AppImage"),
                root,
                "../escape.AppImage",
                7,
                &|| Ok(()),
            )
            .is_err()
        );
    }

    #[cfg(unix)]
    #[test]
    fn standalone_appimage_normalization_rejects_symlinks_and_non_executable_files() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("payload");
        fs::create_dir_all(&root).unwrap();
        let source = temporary.path().join("outside");
        fs::write(&source, b"outside").unwrap();
        let artifact = ArtifactIdentity {
            asset_name: "version.AppImage".into(),
            sha256: "a".repeat(64),
            size: 7,
        };
        let mut qualification = InstallQualification::test("game.AppImage");
        qualification.platform = Platform::LinuxX86_64;
        std::os::unix::fs::symlink(&source, root.join(&artifact.asset_name)).unwrap();
        assert!(normalize_standalone_appimage(&root, &artifact, &qualification).is_err());
        fs::remove_file(root.join(&artifact.asset_name)).unwrap();
        fs::copy(&source, root.join(&artifact.asset_name)).unwrap();
        crate::permissions::normalize_archive_entry(&root.join(&artifact.asset_name), false, false)
            .unwrap();
        assert!(normalize_standalone_appimage(&root, &artifact, &qualification).is_err());
        assert_eq!(fs::read(source).unwrap(), b"outside");
        assert!(!root.join("game.AppImage").exists());
    }

    impl LifecycleFaultInjector for FailOnce {
        fn check(&self, point: LifecycleFaultPoint) -> Result<()> {
            if point == self.point && !self.fired.swap(true, Ordering::SeqCst) {
                return Err(PortcoveError::state(format!(
                    "injected lifecycle failure at {point:?}"
                )));
            }
            Ok(())
        }
    }

    impl LifecycleFaultInjector for FailWithMessage {
        fn check(&self, point: LifecycleFaultPoint) -> Result<()> {
            if point == self.point {
                return Err(PortcoveError::state(self.message));
            }
            Ok(())
        }
    }

    impl LifecycleFaultInjector for FailSequence {
        fn check(&self, point: LifecycleFaultPoint) -> Result<()> {
            let mut points = self.points.lock().unwrap();
            if points.first() == Some(&point) {
                points.remove(0);
                return Err(PortcoveError::state(format!(
                    "injected lifecycle failure at {point:?}"
                )));
            }
            Ok(())
        }
    }

    #[test]
    fn executable_resolution_rejects_ambiguous_basenames_and_accepts_exact_paths() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path();
        fs::create_dir_all(root.join("primary")).unwrap();
        fs::create_dir_all(root.join("secondary")).unwrap();
        fs::write(root.join("primary/game.exe"), b"primary").unwrap();
        fs::write(root.join("secondary/game.exe"), b"secondary").unwrap();
        let mut qualification = InstallQualification::test("game.exe");

        let ambiguous = resolve_declared_executable(root, &qualification).unwrap_err();
        assert_eq!(ambiguous.code, crate::ErrorCode::Conflict);
        assert_eq!(ambiguous.details["hint"], "game.exe");
        assert!(ambiguous.details["candidates"].contains("primary/game.exe"));
        assert!(ambiguous.details["candidates"].contains("secondary/game.exe"));

        qualification.executable_hints = vec!["secondary/game.exe".into()];
        assert_eq!(
            resolve_declared_executable(root, &qualification).unwrap(),
            root.join("secondary/game.exe")
        );
    }

    #[test]
    fn executable_resolution_rejects_unsafe_and_unicode_aliases() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path();
        fs::write(root.join("game.exe"), b"trusted").unwrap();
        let mut qualification = InstallQualification::test("game.exe");
        qualification.executable_hints = vec!["../game.exe".into()];
        assert_eq!(
            resolve_declared_executable(root, &qualification)
                .unwrap_err()
                .code,
            crate::ErrorCode::Verification
        );

        qualification.executable_hints = vec!["game.exe".into()];
        fs::remove_file(root.join("game.exe")).unwrap();
        fs::write(root.join("gamé.exe"), b"lookalike").unwrap();
        assert_eq!(
            resolve_declared_executable(root, &qualification)
                .unwrap_err()
                .code,
            crate::ErrorCode::Verification
        );
    }

    #[cfg(unix)]
    #[test]
    fn executable_resolution_rejects_symlinks() {
        use std::os::unix::fs::{PermissionsExt, symlink};

        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("payload");
        fs::create_dir(&root).unwrap();
        let outside = temporary.path().join("outside");
        fs::write(&outside, b"outside").unwrap();
        fs::set_permissions(&outside, fs::Permissions::from_mode(0o755)).unwrap();
        symlink(&outside, root.join("game")).unwrap();
        let mut qualification = InstallQualification::test("game");
        qualification.platform = Platform::LinuxX86_64;
        assert!(resolve_declared_executable(&root, &qualification).is_err());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn executable_resolution_rejects_case_aliases() {
        use std::os::unix::fs::PermissionsExt;

        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("payload");
        fs::create_dir(&root).unwrap();
        for name in ["Game", "game"] {
            let path = root.join(name);
            fs::write(&path, b"executable").unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let mut qualification = InstallQualification::test("game");
        qualification.platform = Platform::LinuxX86_64;
        let error = resolve_declared_executable(&root, &qualification).unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Conflict);
    }

    #[test]
    fn critical_verification_rejects_new_launch_sensitive_companions() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("payload");
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("saves")).unwrap();
        fs::write(root.join("game.exe"), b"trusted executable").unwrap();
        let mut qualification = InstallQualification::test("game.exe");
        qualification.persistent_paths = vec!["saves".into()];
        let (installer, install) = create_test_install(&root, &qualification);

        for name in [
            "engine.dll",
            "libengine.so",
            "libengine.so.1",
            "engine.dylib",
            "launcher.exe",
            "launch.bat",
            "launch.cmd",
            "launch.ps1",
            "launch.sh",
            "loader.toml",
            "loader.ini",
            "loader.cfg",
        ] {
            let candidate = root.join(name);
            fs::write(&candidate, b"unmanifested").unwrap();
            let error = installer
                .verify_critical(&install, &qualification)
                .unwrap_err();
            assert_eq!(error.code, crate::ErrorCode::Verification, "{name}");
            assert!(error.details["failures"].contains(name), "{name}");
            fs::remove_file(candidate).unwrap();
        }

        fs::write(root.join("notes.txt"), b"benign untracked note").unwrap();
        fs::write(root.join("saves/engine.dll"), b"explicit mutable data").unwrap();
        assert_eq!(
            installer.verify_critical(&install, &qualification).unwrap(),
            root.join("game.exe")
        );
    }

    #[test]
    fn runtime_file_patterns_ignore_only_reviewed_disposable_outputs() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("payload");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("game.exe"), b"trusted executable").unwrap();
        let dump = root.join("psx_freeze_dump_psx-runtime_1_2.json");
        fs::write(&dump, b"initial diagnostic").unwrap();
        let mut qualification = InstallQualification::test("game.exe");
        qualification.runtime_mutable_file_patterns = vec![crate::PersistentFilePattern {
            prefix: "psx_freeze_dump_".into(),
            suffix: ".json".into(),
        }];
        let (installer, install) = create_test_install(&root, &qualification);

        let manifest = verified_manifest(&install).unwrap();
        assert_eq!(manifest.mutable_file_patterns.len(), 1);
        assert!(
            !manifest
                .files
                .iter()
                .any(|file| file.path.ends_with(".json"))
        );
        fs::write(&dump, b"changed diagnostic").unwrap();
        assert!(installer.verify(&install).unwrap().valid);
        assert_eq!(
            installer.verify_critical(&install, &qualification).unwrap(),
            root.join("game.exe")
        );

        let invalid = root.join("psx_freeze_dump_directory.json");
        fs::create_dir(&invalid).unwrap();
        let report = installer.verify(&install).unwrap();
        assert!(!report.valid);
        assert!(
            report
                .failures
                .iter()
                .any(|failure| failure.contains("invalid mutable-pattern entry"))
        );
        assert!(installer.verify_critical(&install, &qualification).is_err());
        fs::remove_dir(&invalid).unwrap();

        fs::write(root.join("unexpected.dll"), b"unreviewed code").unwrap();
        assert!(!installer.verify(&install).unwrap().valid);
        assert!(installer.verify_critical(&install, &qualification).is_err());
    }

    #[test]
    fn runtime_file_patterns_cannot_overlap_persistent_patterns() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path();
        let selected = root.join("game.exe");
        let mut qualification = InstallQualification::test("game.exe");
        qualification.persistent_file_patterns = vec![crate::PersistentFilePattern {
            prefix: "psx_freeze_dump_".into(),
            suffix: ".json".into(),
        }];
        qualification.runtime_mutable_file_patterns = vec![crate::PersistentFilePattern {
            prefix: "psx_freeze_dump_psx-runtime_".into(),
            suffix: "_1.json".into(),
        }];

        let error = qualification.file_patterns(root, &selected).unwrap_err();
        assert!(error.message.contains("patterns overlap"));
    }

    #[test]
    fn runtime_source_set_members_remain_immutable() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("payload");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("game.exe"), b"trusted executable").unwrap();
        let source = root.join("baserom.us.rev0.z64");
        fs::write(&source, b"trusted source").unwrap();
        let catalog = crate::Catalog::embedded().unwrap();
        let port = catalog.port("g-diffuser").unwrap();
        let mut qualification =
            crate::test_fixture::retained_qualification(port, Platform::WindowsX86_64).unwrap();
        fs::rename(root.join("game.exe"), root.join("G-Diffuser.exe")).unwrap();

        let (installer, install) = create_test_install(&root, &qualification);
        let manifest = verified_manifest(&install).unwrap();
        assert!(
            manifest
                .files
                .iter()
                .any(|file| { file.path == "baserom.us.rev0.z64" && !file.critical })
        );
        installer
            .verify_import_contract(&install, &qualification)
            .unwrap();
        fs::write(&source, b"changed source").unwrap();
        assert!(!installer.verify(&install).unwrap().valid);

        fs::write(&source, b"trusted source").unwrap();
        qualification.runtime_mutable_file_patterns = vec![crate::PersistentFilePattern {
            prefix: "baserom.".into(),
            suffix: ".z64".into(),
        }];
        let error =
            manifest_files(&root, &qualification, &root.join("G-Diffuser.exe")).unwrap_err();
        assert!(
            error
                .message
                .contains("matched executable, source, or bootstrap")
        );
    }

    #[test]
    fn critical_verification_upgrades_legacy_recorded_companion_coverage() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("payload");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("game.exe"), b"trusted executable").unwrap();
        fs::write(root.join("helper.exe"), b"trusted helper").unwrap();
        let qualification = InstallQualification::test("game.exe");
        let (installer, mut install) = create_test_install(&root, &qualification);
        eprintln!("legacy companion fixture created");

        let manifest_path = root.join(".portcove-manifest.json");
        let mut value: serde_json::Value =
            serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        let helper = value["files"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|file| file["path"] == "helper.exe")
            .unwrap();
        helper["critical"] = false.into();
        let bytes = serde_json::to_vec_pretty(&value).unwrap();
        fs::write(&manifest_path, &bytes).unwrap();
        install.manifest_sha256 = hex::encode(Sha256::digest(&bytes));
        eprintln!("legacy companion manifest written; verifying trusted files");

        assert_eq!(
            installer.verify_critical(&install, &qualification).unwrap(),
            root.join("game.exe")
        );
        fs::write(root.join("helper.exe"), b"tampered helper").unwrap();
        eprintln!("companion changed; verifying tamper rejection");
        let error = installer
            .verify_critical(&install, &qualification)
            .unwrap_err();
        assert!(error.details["failures"].contains("changed: helper.exe"));
    }

    #[cfg(unix)]
    #[test]
    fn critical_verification_rejects_selected_and_companion_symlinks() {
        use std::os::unix::fs::{PermissionsExt, symlink};

        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("payload");
        fs::create_dir(&root).unwrap();
        let executable = root.join("game");
        fs::write(&executable, b"trusted executable").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        let mut qualification = InstallQualification::test("game");
        qualification.platform = Platform::LinuxX86_64;
        let (installer, install) = create_test_install(&root, &qualification);
        let outside = temporary.path().join("outside");
        fs::write(&outside, b"trusted executable").unwrap();
        fs::set_permissions(&outside, fs::Permissions::from_mode(0o755)).unwrap();

        fs::remove_file(&executable).unwrap();
        symlink(&outside, &executable).unwrap();
        assert!(installer.verify_critical(&install, &qualification).is_err());

        fs::remove_file(&executable).unwrap();
        fs::write(&executable, b"trusted executable").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        symlink(&outside, root.join("engine.so")).unwrap();
        let error = installer
            .verify_critical(&install, &qualification)
            .unwrap_err();
        assert!(error.details["failures"].contains("engine.so"));
    }

    #[cfg(unix)]
    #[test]
    fn unix_manifest_binds_executable_intent_for_adoption_and_verification() {
        use std::os::unix::fs::PermissionsExt;

        fn set_mode(path: &Path, mode: u32) {
            fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
        }

        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("payload");
        fs::create_dir(&root).unwrap();
        let executable = root.join("run.sh");
        let data = root.join("data.txt");
        fs::write(&executable, b"#!/bin/sh\nexit 0\n").unwrap();
        fs::write(&data, b"immutable data").unwrap();
        set_mode(&executable, 0o755);
        set_mode(&data, 0o644);

        let library = Library::open(temporary.path().join("library")).unwrap();
        let installer = Installer::new(library).unwrap();
        let mut qualification = InstallQualification::test("run.sh");
        qualification.platform = Platform::current().unwrap();
        let artifact = ArtifactIdentity {
            asset_name: "local-adoption".into(),
            sha256: "a".repeat(64),
            size: 32,
        };
        let (manifest_sha256, selected_executable, runtime) = installer
            .create_manifest(
                "unix-install",
                "sample",
                "v1",
                &artifact,
                &qualification,
                &root,
            )
            .unwrap();
        let install = InstallRecord {
            id: "unix-install".into(),
            port_id: "sample".into(),
            version: "v1".into(),
            path: root.clone(),
            channel: crate::ReleaseChannel::Stable,
            installed_at: 1,
            verified: true,
            staged: false,
            artifact,
            runtime,
            manifest_sha256,
            selected_executable,
        };

        let manifest = verified_manifest(&install).unwrap();
        assert_eq!(manifest.schema_version, 6);
        assert_eq!(manifest.platform, Some(qualification.platform));
        assert!(
            manifest
                .files
                .iter()
                .find(|file| file.path == "run.sh")
                .unwrap()
                .executable
        );
        assert!(
            !manifest
                .files
                .iter()
                .find(|file| file.path == "data.txt")
                .unwrap()
                .executable
        );
        assert!(
            installer
                .verify_managed(&install, &qualification)
                .unwrap()
                .valid
        );
        assert_eq!(
            installer.verify_critical(&install, &qualification).unwrap(),
            executable
        );

        set_mode(&executable, 0o644);
        let lost_execute = installer.verify_managed(&install, &qualification).unwrap();
        assert!(!lost_execute.valid);
        assert!(
            lost_execute
                .failures
                .contains(&"permissions changed: run.sh".into())
        );
        assert!(installer.verify_critical(&install, &qualification).is_err());

        set_mode(&executable, 0o755);
        set_mode(&data, 0o755);
        let broadened = installer.verify_managed(&install, &qualification).unwrap();
        assert!(!broadened.valid);
        assert!(
            broadened
                .failures
                .contains(&"permissions changed: data.txt".into())
        );
        installer
            .verify_import_contract(&install, &qualification)
            .unwrap_err();
    }

    #[test]
    fn legacy_manifest_without_platform_or_permission_metadata_remains_readable() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("payload");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("game.exe"), b"verified fixture").unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let installer = Installer::new(library).unwrap();
        let qualification = InstallQualification::test("game.exe");
        let artifact = ArtifactIdentity {
            asset_name: "legacy.zip".into(),
            sha256: "b".repeat(64),
            size: 16,
        };
        let (manifest_sha256, selected_executable, runtime) = write_manifest(
            "legacy-install",
            "sample",
            "v1",
            &artifact,
            &qualification,
            &root,
        )
        .unwrap();
        let mut install = InstallRecord {
            id: "legacy-install".into(),
            port_id: "sample".into(),
            version: "v1".into(),
            path: root.clone(),
            channel: crate::ReleaseChannel::Stable,
            installed_at: 1,
            verified: true,
            staged: false,
            artifact,
            runtime,
            manifest_sha256,
            selected_executable,
        };

        let manifest_path = root.join(".portcove-manifest.json");
        let mut value: serde_json::Value =
            serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        let object = value.as_object_mut().unwrap();
        object.insert("schema_version".into(), 4.into());
        object.remove("retained_contract");
        object.remove("platform");
        for file in object.get_mut("files").unwrap().as_array_mut().unwrap() {
            file.as_object_mut().unwrap().remove("executable");
        }
        let bytes = serde_json::to_vec_pretty(&value).unwrap();
        fs::write(&manifest_path, &bytes).unwrap();
        install.manifest_sha256 = hex::encode(Sha256::digest(&bytes));

        assert_eq!(verified_manifest(&install).unwrap().schema_version, 4);
        let (retained, platform) = retained_query_context(&install).unwrap();
        assert!(retained.is_none());
        assert!(platform.is_none());
        let mut metadata_budget = bytes.len() as u64 + 1024;
        let (retained, platform) =
            retained_query_context_with_budget(&install, Some(&mut metadata_budget)).unwrap();
        assert!(retained.is_none());
        assert!(platform.is_none());
        assert_eq!(metadata_budget, 1024);
        let mut too_small = bytes.len() as u64 - 1;
        assert!(retained_query_context_with_budget(&install, Some(&mut too_small)).is_err());
        assert_eq!(too_small, 0);
        assert!(installer.verify(&install).unwrap().valid);
        assert!(installer.verify_critical(&install, &qualification).is_ok());
        installer
            .verify_import_contract(&install, &qualification)
            .unwrap();
    }

    #[test]
    fn managed_psx_runtime_source_is_manifest_critical() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("payload");
        let working = root.join("build-portcove");
        let runtime_source = working.join("runtime-discs");
        fs::create_dir_all(&runtime_source).unwrap();
        let selected = working.join("Final_Fantasy_7.exe");
        fs::write(&selected, b"verified fixture").unwrap();
        fs::write(working.join("README.txt"), b"noncritical fixture").unwrap();
        for index in 1..=3 {
            fs::write(
                runtime_source.join(format!("disc-{index:02}.bin")),
                format!("disc {index}"),
            )
            .unwrap();
            fs::write(
                runtime_source.join(format!("disc-{index:02}.cue")),
                format!("FILE \"disc-{index:02}.bin\" BINARY\n"),
            )
            .unwrap();
        }
        let catalog = crate::Catalog::embedded().unwrap();
        let qualification = crate::test_fixture::retained_qualification(
            catalog.port("final-fantasy-vii-recompiled").unwrap(),
            Platform::WindowsX86_64,
        )
        .unwrap();

        let (files, _) = manifest_files(&root, &qualification, &selected).unwrap();

        let source_files = files
            .iter()
            .filter(|file| file.path.contains("runtime-discs/"))
            .collect::<Vec<_>>();
        assert_eq!(source_files.len(), 6);
        assert!(source_files.iter().all(|file| file.critical));
        assert!(
            files
                .iter()
                .any(|file| file.path.ends_with("README.txt") && !file.critical)
        );
    }

    #[test]
    fn managed_verification_accepts_exact_generated_metadata_in_legacy_installs() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let root = temporary.path().join("payload");
        let working = root.join("Paper Mario ReCut");
        fs::create_dir_all(&working).unwrap();
        let executable = working.join("PaperMarioReCut.exe");
        fs::write(&executable, b"verified fixture").unwrap();
        let catalog = crate::Catalog::embedded().unwrap();
        let qualification = crate::test_fixture::retained_qualification(
            catalog.port("paper-mario-recut").unwrap(),
            Platform::WindowsX86_64,
        )
        .unwrap();
        let mut legacy = qualification.clone();
        legacy.generated_metadata.clear();
        let artifact = ArtifactIdentity {
            asset_name: "fixture.zip".into(),
            sha256: "0".repeat(64),
            size: 16,
        };
        let (manifest_sha256, selected_executable, runtime) = write_manifest(
            "legacy",
            "paper-mario-recut",
            "v1",
            &artifact,
            &legacy,
            &root,
        )
        .unwrap();
        let install = InstallRecord {
            id: "legacy".into(),
            port_id: "paper-mario-recut".into(),
            version: "v1".into(),
            path: root.clone(),
            channel: crate::ReleaseChannel::Beta,
            installed_at: 1,
            verified: true,
            staged: false,
            artifact,
            manifest_sha256,
            selected_executable,
            runtime,
        };
        let original_manifest = fs::read(root.join(".portcove-manifest.json")).unwrap();
        fs::write(working.join("portable.txt"), b"").unwrap();
        let installer = Installer::new(library).unwrap();
        assert!(!installer.verify(&install).unwrap().valid);
        assert!(
            installer
                .verify_managed(&install, &qualification)
                .unwrap()
                .valid
        );
        installer
            .verify_import_contract(&install, &qualification)
            .unwrap();
        assert_eq!(
            fs::read(root.join(".portcove-manifest.json")).unwrap(),
            original_manifest
        );

        let unexpected = working.join("unknown.portcove-source.json");
        fs::write(&unexpected, b"untrusted").unwrap();
        assert!(
            !installer
                .verify_managed(&install, &qualification)
                .unwrap()
                .valid
        );
        assert!(
            installer
                .verify_import_contract(&install, &qualification)
                .is_err()
        );
        fs::remove_file(unexpected).unwrap();
        fs::write(executable, b"changed fixture!").unwrap();
        assert!(
            !installer
                .verify_managed(&install, &qualification)
                .unwrap()
                .valid
        );
        assert!(
            installer
                .verify_import_contract(&install, &qualification)
                .is_err()
        );
    }

    #[test]
    fn upstream_setup_refresh_adds_generated_game_data_to_immutable_manifest() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let root = temporary.path().join("payload");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("gk.exe"), b"verified game executable").unwrap();
        fs::write(root.join("extractor.exe"), b"verified setup executable").unwrap();
        let artifact = ArtifactIdentity {
            asset_name: "opengoal.zip".into(),
            sha256: "1".repeat(64),
            size: 32,
        };
        let qualification = crate::test_fixture::retained_qualification(
            crate::Catalog::embedded()
                .unwrap()
                .port("opengoal-jak1")
                .unwrap(),
            Platform::WindowsX86_64,
        )
        .unwrap();
        let mut initial_qualification = qualification.clone();
        initial_qualification.runtime_mutable_paths = vec!["data/log".into()];
        let (manifest_sha256, selected_executable, runtime) = write_manifest(
            "setup-install",
            "opengoal-jak1",
            "v1",
            &artifact,
            &initial_qualification,
            &root,
        )
        .unwrap();
        let install = InstallRecord {
            id: "setup-install".into(),
            port_id: "opengoal-jak1".into(),
            version: "v1".into(),
            path: root.clone(),
            channel: crate::ReleaseChannel::Stable,
            installed_at: 1,
            verified: true,
            staged: false,
            artifact,
            manifest_sha256,
            selected_executable,
            runtime,
        };
        fs::write(root.join("source.iso"), b"verified retail disc").unwrap();
        let generated = root.join("data/out/jak1/iso");
        fs::create_dir_all(&generated).unwrap();
        fs::write(generated.join("0COMMON.TXT"), b"generated game data").unwrap();
        fs::write(root.join("data/imgui.ini"), b"runtime UI layout").unwrap();
        fs::write(
            root.join(".portcove-upstream-setup.json"),
            br#"{"schema_version":1}"#,
        )
        .unwrap();
        let installer = Installer::new(library).unwrap();
        let initial_report = installer.verify_managed(&install, &qualification).unwrap();
        assert!(!initial_report.valid);
        assert!(
            !initial_report
                .failures
                .iter()
                .any(|failure| failure.contains("data/imgui.ini"))
        );

        let refreshed = installer
            .refresh_verified_manifest(&install, &qualification)
            .unwrap();
        let report = installer
            .verify_managed(&refreshed, &qualification)
            .unwrap();

        assert!(report.valid, "{:?}", report.failures);
        assert!(report.checked_files > 2);
        fs::write(generated.join("0COMMON.TXT"), b"tampered game data").unwrap();
        assert!(
            !installer
                .verify_managed(&refreshed, &qualification)
                .unwrap()
                .valid
        );
    }

    #[test]
    fn manifest_refresh_and_preparation_preserve_the_original_contract() {
        assert_manifest_retention(false);
    }

    #[test]
    fn ghostship_prepared_interpretation_survives_refresh_and_refuses_missing_critical_members() {
        let temporary = tempfile::tempdir().unwrap();
        let catalog = crate::test_fixture::admitted_indexed_catalog(
            &crate::Catalog::embedded().unwrap(),
            "ghostship",
        );
        let qualification =
            InstallQualification::from_catalog(&catalog, "ghostship", Platform::WindowsX86_64)
                .unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let installer = Installer::new(library.clone()).unwrap();
        let root = temporary.path().join("original");
        fs::create_dir(&root).unwrap();
        // Inert fixture bytes: no package provenance or execution is claimed.
        fs::write(root.join("Ghostship.exe"), b"inert fixture executable").unwrap();
        let artifact = ArtifactIdentity {
            asset_name: "Mary-Celeste-Alfa-Win64.zip".into(),
            sha256: "a49f4c791377fcc611264b8920f2c3254b3ab25747c2a59da9305c32f92a6d3f".into(),
            size: 21_561_620,
        };
        let (manifest_sha256, selected_executable, runtime) = write_manifest(
            "original",
            "ghostship",
            "2.0.0",
            &artifact,
            &qualification,
            &root,
        )
        .unwrap();
        let original = InstallRecord {
            id: "original".into(),
            port_id: "ghostship".into(),
            version: "2.0.0".into(),
            path: root,
            channel: crate::ReleaseChannel::Stable,
            installed_at: 0,
            verified: true,
            staged: false,
            artifact,
            runtime,
            manifest_sha256,
            selected_executable,
        };
        let derived = temporary.path().join("prepared");
        fs::create_dir_all(derived.join("prepared-game-data")).unwrap();
        fs::write(derived.join("Ghostship.exe"), b"inert fixture executable").unwrap();
        fs::write(
            derived.join(crate::preparation::RECEIPT_FILE),
            b"inert receipt",
        )
        .unwrap();
        fs::write(
            derived.join("prepared-game-data/sm64.o2r"),
            b"inert generated member",
        )
        .unwrap();
        let source = temporary.path().join("inert-original.z64");
        fs::write(&source, b"inert original fixture").unwrap();
        crate::adapter::record_prepared_setup(&derived, &source).unwrap();
        let setup_metadata = derived.join(crate::adapter::UPSTREAM_SETUP_METADATA);
        let original_metadata = fs::read(&setup_metadata).unwrap();
        let prepared = installer
            .create_prepared_manifest(
                &original,
                "prepared",
                &qualification,
                crate::PreparationMode::Ghostship200Legacy,
                &derived,
            )
            .unwrap();
        crate::preparation::bind_prepared_setup_manifest(
            crate::PreparationMode::Ghostship200Legacy,
            &derived,
            &prepared.manifest_sha256,
        )
        .unwrap();
        assert_eq!(fs::read(&setup_metadata).unwrap(), original_metadata);
        let report = installer.verify(&prepared).unwrap();
        assert!(report.valid, "{:?}", report.failures);
        // Ordinary managed setup still binds metadata. Doing so here reproduces
        // the real publication failure because this mode records it immutably.
        crate::preparation::bind_prepared_setup_manifest(
            crate::PreparationMode::Default,
            &derived,
            &prepared.manifest_sha256,
        )
        .unwrap();
        assert!(!installer.verify(&prepared).unwrap().valid);
        assert!(
            !crate::adapter::upstream_setup_manifest_needs_refresh(
                &derived,
                &prepared.manifest_sha256,
            )
            .unwrap()
        );
        fs::write(&setup_metadata, original_metadata).unwrap();
        assert!(installer.verify(&prepared).unwrap().valid);
        let before = verified_manifest(&prepared).unwrap();
        let contract = serde_json::to_value(&before.retained_contract).unwrap();
        assert_eq!(contract["format"], 4);
        assert_eq!(contract["original_format"], 3);
        installer
            .verify_import_contract(&prepared, &qualification)
            .unwrap();
        let refreshed = installer
            .refresh_verified_manifest(&prepared, &qualification)
            .unwrap();
        let manifest = verified_manifest(&refreshed).unwrap();
        assert_eq!(
            serde_json::to_value(&manifest.retained_contract).unwrap(),
            contract
        );
        for path in [
            crate::preparation::RECEIPT_FILE,
            "prepared-game-data/sm64.o2r",
        ] {
            for remove in [false, true] {
                let mut malformed = serde_json::to_value(&manifest).unwrap();
                let files = malformed["files"].as_array_mut().unwrap();
                if remove {
                    files.retain(|file| file["path"] != path);
                } else {
                    files.iter_mut().find(|file| file["path"] == path).unwrap()["critical"] =
                        serde_json::json!(false);
                }
                let bytes = serde_json::to_vec(&malformed).unwrap();
                fs::write(derived.join(".portcove-manifest.json"), &bytes).unwrap();
                let mut changed = refreshed.clone();
                changed.manifest_sha256 = hex::encode(Sha256::digest(&bytes));
                assert!(
                    verified_manifest(&changed)
                        .unwrap_err()
                        .message
                        .contains("bounded critical")
                );
            }
        }
    }

    #[test]
    fn successor_manifest_refresh_and_preparation_preserve_exact_original_bytes() {
        assert_manifest_retention(true);
    }

    fn assert_manifest_retention(successor: bool) {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("payload");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("game.exe"), b"owned executable").unwrap();
        let mut original = InstallQualification::test("game.exe");
        if successor {
            let catalog = original
                .retained_contract
                .as_ref()
                .unwrap()
                .catalog("sample")
                .unwrap();
            let indexed = crate::test_fixture::indexed_catalog(&catalog, "sample");
            original =
                InstallQualification::from_catalog(&indexed, "sample", original.platform).unwrap();
        }
        let (installer, install) = create_test_install(&root, &original);
        let exact_contract =
            serde_json::to_value(verified_manifest(&install).unwrap().retained_contract).unwrap();
        assert_eq!(exact_contract["format"], if successor { 2 } else { 1 });
        let retained = installer.retained_catalog(&install).unwrap().unwrap();
        let mut document = retained.authoritative_document();
        let changed = document
            .ports
            .iter_mut()
            .find(|port| port.id == install.port_id)
            .unwrap();
        changed.launch_arguments.push("--future".into());
        changed.persistent_paths.push("future-data".into());
        let future = crate::Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap();
        let current =
            InstallQualification::from_catalog(&future, &install.port_id, original.platform)
                .unwrap();
        let refreshed = installer
            .refresh_verified_manifest(&install, &current)
            .unwrap();
        let derived = temporary.path().join("prepared");
        fs::create_dir_all(&derived).unwrap();
        fs::write(derived.join("game.exe"), b"owned executable").unwrap();
        fs::write(
            derived.join(crate::preparation::RECEIPT_FILE),
            b"owned receipt",
        )
        .unwrap();
        let prepared = installer
            .create_prepared_manifest(
                &refreshed,
                "prepared-id",
                &current,
                crate::PreparationMode::Default,
                &derived,
            )
            .unwrap();
        for version in [&refreshed, &prepared] {
            assert_eq!(
                serde_json::to_value(verified_manifest(version).unwrap().retained_contract)
                    .unwrap(),
                exact_contract
            );
            assert_eq!(
                serde_json::to_value(
                    installer
                        .retained_catalog(version)
                        .unwrap()
                        .unwrap()
                        .authoritative_document()
                )
                .unwrap(),
                serde_json::to_value(retained.authoritative_document()).unwrap()
            );
        }
        // The retained content is protected by the same immutable manifest digest.
        let path = prepared.path.join(".portcove-manifest.json");
        let content = fs::read_to_string(&path)
            .unwrap()
            .replace("sample", "forged");
        fs::write(path, content).unwrap();
        assert!(installer.retained_catalog(&prepared).is_err());
    }

    #[test]
    fn new_persistent_declarations_do_not_rewrite_recorded_immutable_identity() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("payload");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("game.exe"), b"verified executable").unwrap();
        fs::write(root.join("engine.dll"), b"verified engine").unwrap();
        let original = InstallQualification::test("game.exe");
        let (installer, install) = create_test_install(&root, &original);
        let mut current = original.clone();
        current.persistent_paths.push("preferences".into());
        current.persistent_paths.push("input.ini".into());
        current.runtime_mutable_paths.push("disc.cfg".into());
        fs::write(root.join("input.ini"), b"user input mapping").unwrap();
        fs::write(root.join("disc.cfg"), b"generated disc cache").unwrap();
        current
            .generated_metadata
            .push(".portcove-psx-runtime.toml".into());
        fs::write(
            root.join(".portcove-psx-runtime.toml"),
            b"generated configuration",
        )
        .unwrap();
        fs::create_dir(root.join("preferences")).unwrap();
        fs::write(root.join("preferences/settings.ini"), b"new preference").unwrap();
        assert!(installer.verify_managed(&install, &current).unwrap().valid);
        assert!(installer.verify_critical(&install, &current).is_ok());
        installer
            .verify_import_contract(&install, &current)
            .unwrap();
        fs::write(root.join("unexpected.dll"), b"unreviewed file").unwrap();
        assert!(!installer.verify_managed(&install, &current).unwrap().valid);
        assert!(installer.verify_critical(&install, &current).is_err());
        fs::remove_file(root.join("unexpected.dll")).unwrap();
        current.persistent_paths.push("late.dll".into());
        fs::write(root.join("late.dll"), b"unmanifested engine").unwrap();
        let report = installer.verify_managed(&install, &current).unwrap();
        assert!(!report.valid);
        assert!(
            report
                .failures
                .contains(&"unexpected launch-sensitive file: late.dll".into())
        );
        assert!(installer.verify_critical(&install, &current).is_err());
        fs::remove_file(root.join("late.dll")).unwrap();
        current.persistent_paths.push("engine.dll".into());
        fs::write(root.join("engine.dll"), b"changed engine").unwrap();
        let report = installer.verify_managed(&install, &current).unwrap();
        assert!(!report.valid);
        assert!(report.failures.contains(&"changed: engine.dll".into()));
        assert!(installer.verify_critical(&install, &current).is_err());
        assert!(
            installer
                .verify_import_contract(&install, &current)
                .is_err()
        );
        fs::write(root.join("game.exe"), b"changed executable").unwrap();
        assert!(installer.verify_critical(&install, &current).is_err());
    }

    #[test]
    fn additive_mutability_refuses_recorded_files_and_executable_companions() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("payload");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("game.exe"), b"verified executable").unwrap();
        fs::write(root.join("template.json"), b"immutable template").unwrap();
        let original = InstallQualification::test("game.exe");
        let (installer, install) = create_test_install(&root, &original);
        let mut current = original.clone();
        current.persistent_paths.push("template.json".into());
        assert!(
            !installer
                .permits_additive_mutability(&install, &original, &current)
                .unwrap()
        );
        current.persistent_paths = vec!["late.dll".into()];
        assert!(
            !installer
                .permits_additive_mutability(&install, &original, &current)
                .unwrap()
        );
        current.persistent_paths = vec!["settings.ini".into()];
        assert!(
            installer
                .permits_additive_mutability(&install, &original, &current)
                .unwrap()
        );
    }

    #[test]
    fn ghostship_runtime_outputs_do_not_hide_unknown_files_or_executable_tampering() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("payload");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("ghostship.exe"), b"verified executable").unwrap();
        let port = crate::Catalog::embedded()
            .unwrap()
            .port("ghostship")
            .unwrap()
            .clone();
        let qualification =
            crate::test_fixture::retained_qualification(&port, Platform::WindowsX86_64).unwrap();
        let (installer, install) = create_test_install(&root, &qualification);
        fs::create_dir_all(root.join("logs")).unwrap();
        fs::write(root.join("torch.hash.yml"), b"generated extraction cache").unwrap();
        fs::write(root.join("logs/Ghostship.log"), b"current log").unwrap();
        for index in 1..=10 {
            fs::write(
                root.join(format!("logs/Ghostship.{index}.log")),
                b"rotated log",
            )
            .unwrap();
        }
        assert!(
            installer
                .verify_managed(&install, &qualification)
                .unwrap()
                .valid
        );
        let unknown = root.join("logs/unexpected.dll");
        fs::write(&unknown, b"unreviewed file").unwrap();
        assert!(
            !installer
                .verify_managed(&install, &qualification)
                .unwrap()
                .valid
        );
        fs::remove_file(unknown).unwrap();
        fs::write(root.join("ghostship.exe"), b"modified executable").unwrap();
        assert!(
            !installer
                .verify_managed(&install, &qualification)
                .unwrap()
                .valid
        );
        assert!(installer.verify_critical(&install, &qualification).is_err());
    }

    #[test]
    fn artifact_digests_are_canonical_collision_free_storage_keys() {
        let first = artifact_storage_key(&"A".repeat(64)).unwrap();
        let second = artifact_storage_key(&"b".repeat(64)).unwrap();
        assert_eq!(first, "a".repeat(64));
        assert_eq!(second, "b".repeat(64));
        assert_ne!(first, second);
        for display_version in [
            "release/path".to_string(),
            "release\\path".to_string(),
            "a".repeat(512),
            "rélease-日本語".to_string(),
        ] {
            assert_eq!(
                artifact_storage_key(&"A".repeat(64)).unwrap(),
                first,
                "{display_version}"
            );
        }
        assert!(artifact_storage_key("../../bad tag").is_err());
    }

    #[tokio::test]
    async fn install_refuses_to_trust_a_preexisting_version_directory() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        fs::create_dir_all(library.versions_dir().join("sample").join("0".repeat(64))).unwrap();
        let installer = Installer::new(library.clone()).unwrap();
        let request = InstallRequest {
            port_id: "sample".into(),
            output_root: library.versions_dir().join("sample"),
            release: ResolvedRelease {
                version: "v1".into(),
                channel: crate::ReleaseChannel::Stable,
                published_at: None,
                asset: crate::ReleaseAsset {
                    name: "sample.zip".into(),
                    url: "https://invalid.example/sample.zip".into(),
                    size: 1,
                    sha256: "0".repeat(64),
                },
            },
            activate: true,
            managed: None,
            qualification: InstallQualification::test("sample-game.exe"),
        };

        let operation = OperationCoordinator::new("install", None);
        let error = installer
            .install(request, &operation, |_| {})
            .await
            .unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Conflict);
    }

    #[tokio::test]
    async fn slow_streaming_download_has_idle_bounds_without_a_total_deadline() {
        use std::{
            io::{Read, Write},
            net::TcpListener,
            thread,
        };

        let chunk = vec![b'x'; 64 * 1024];
        let chunk_count = 10;
        let total_size = chunk.len() * chunk_count;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request).unwrap();
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {total_size}\r\nConnection: close\r\n\r\n"
            )
            .unwrap();
            for _ in 0..chunk_count {
                stream.write_all(&chunk).unwrap();
                stream.flush().unwrap();
                thread::sleep(Duration::from_millis(25));
            }
        });
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let installer = Installer::with_network_bounds(
            library,
            Duration::from_millis(50),
            // This case proves that the connect bound does not become a total
            // transfer deadline. The separate stalled-stream test exercises
            // the read-idle bound with a deliberate gap.
            Duration::from_secs(2),
        )
        .unwrap();
        let destination = temporary.path().join("slow.download");
        let asset = ReleaseAsset {
            name: "slow.zip".into(),
            url: format!("http://{address}/slow.zip"),
            size: total_size as u64,
            sha256: "a".repeat(64),
        };
        let operation = OperationCoordinator::new("download", None);
        let started = std::time::Instant::now();
        let mut emit = |_| {};
        installer
            .download(&asset, &destination, &operation, &mut emit)
            .await
            .unwrap();
        assert!(started.elapsed() > Duration::from_millis(180));
        assert_eq!(fs::metadata(destination).unwrap().len(), total_size as u64);
        server.join().unwrap();
    }

    struct StalledDownloadServer {
        address: std::net::SocketAddr,
        stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
        worker: Option<std::thread::JoinHandle<bool>>,
    }

    impl StalledDownloadServer {
        fn start() -> Self {
            use std::{
                io::{ErrorKind, Read, Write},
                net::TcpListener,
                sync::{Arc, atomic::AtomicBool},
                thread,
            };
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let address = listener.local_addr().unwrap();
            let stop = Arc::new(AtomicBool::new(false));
            let worker_stop = Arc::clone(&stop);
            let (ready_sender, ready_receiver) = std::sync::mpsc::channel();
            let worker = thread::spawn(move || {
                if ready_sender.send(()).is_err() {
                    return false;
                }
                let Some(mut stream) = crate::test_fixture::phase("stalled-server accept", || {
                    while !worker_stop.load(std::sync::atomic::Ordering::Acquire) {
                        match listener.accept() {
                            Ok((stream, _)) => return Some(stream),
                            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                                thread::sleep(Duration::from_millis(5));
                            }
                            Err(error) => panic!("stalled fixture accept failed: {error}"),
                        }
                    }
                    None
                }) else {
                    return false;
                };
                stream.set_nonblocking(true).unwrap();
                let mut request = [0_u8; 1024];
                let request_received = crate::test_fixture::phase("stalled-server request", || {
                    while !worker_stop.load(std::sync::atomic::Ordering::Acquire) {
                        match stream.read(&mut request) {
                            Ok(0) => return false,
                            Ok(_) => return true,
                            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                                thread::sleep(Duration::from_millis(5));
                            }
                            Err(error) => panic!("stalled fixture request failed: {error}"),
                        }
                    }
                    false
                });
                if !request_received {
                    return false;
                }
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_write_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                if stream
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nx")
                    .and_then(|()| stream.flush())
                    .is_err()
                {
                    return false;
                }
                // Retain the original deliberate gap, then keep the connection
                // open until the client finishes. A fixture-imposed EOF cannot
                // silently substitute for the client's read-idle timeout.
                thread::sleep(Duration::from_millis(180));
                let deadline = std::time::Instant::now() + Duration::from_secs(2);
                while !worker_stop.load(std::sync::atomic::Ordering::Acquire) {
                    if std::time::Instant::now() >= deadline {
                        return false;
                    }
                    thread::sleep(Duration::from_millis(5));
                }
                true
            });
            let server = Self {
                address,
                stop,
                worker: Some(worker),
            };
            crate::test_fixture::phase("stalled-server ready", || {
                ready_receiver.recv_timeout(Duration::from_secs(2))
            })
            .expect("the owned fixture server did not become ready");
            server
        }

        fn finish(mut self) -> bool {
            self.stop.store(true, std::sync::atomic::Ordering::Release);
            crate::test_fixture::phase("stalled-server join", || self.worker.take().unwrap().join())
                .unwrap()
        }
    }

    impl Drop for StalledDownloadServer {
        fn drop(&mut self) {
            self.stop.store(true, std::sync::atomic::Ordering::Release);
            if let Some(worker) = self.worker.take() {
                let _ = worker.join();
            }
        }
    }

    #[tokio::test]
    async fn streaming_download_fails_after_a_read_idle_stall() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        // Reqwest's read timer also covers connection/header admission. Keep
        // the connect bound, allow measured loopback admission margin, and
        // prove the body received a byte before the full idle interval elapsed.
        let read_idle_timeout = Duration::from_millis(250);
        let installer =
            Installer::with_network_bounds(library, Duration::from_millis(50), read_idle_timeout)
                .unwrap();
        let server = StalledDownloadServer::start();
        let asset = ReleaseAsset {
            name: "stalled.zip".into(),
            url: format!("http://{}/stalled.zip", server.address),
            size: 2,
            sha256: "a".repeat(64),
        };
        let operation = OperationCoordinator::new("download", None);
        let mut emit = |_| {};
        let destination = temporary.path().join("stalled.download");
        let download_started = std::time::Instant::now();
        let error = installer
            .download(&asset, &destination, &operation, &mut emit)
            .await
            .unwrap_err();
        let download_elapsed = download_started.elapsed();
        eprintln!("fixture download error after {download_elapsed:?}: {error:?}");
        let partial_body_sent = server.finish();
        assert_eq!(error.code, crate::ErrorCode::Network);
        assert!(
            download_elapsed >= read_idle_timeout,
            "the received partial body must reach the full read-idle interval"
        );
        assert!(
            partial_body_sent,
            "the fixture never reached a partial-body read-idle stall"
        );
        assert_eq!(
            fs::read(destination).unwrap(),
            b"x",
            "the client must have received the partial body"
        );
    }

    #[tokio::test]
    async fn streaming_download_client_error_before_connection_quiesces_the_fixture() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let installer = Installer::with_network_bounds(
            library,
            Duration::from_millis(50),
            Duration::from_millis(50),
        )
        .unwrap();
        let server = StalledDownloadServer::start();
        let asset = ReleaseAsset {
            name: "invalid-url.zip".into(),
            url: "http://[invalid".into(),
            size: 2,
            sha256: "a".repeat(64),
        };
        let operation = OperationCoordinator::new("download", None);
        let mut emit = |_| {};
        let error = installer
            .download(
                &asset,
                &temporary.path().join("invalid.download"),
                &operation,
                &mut emit,
            )
            .await
            .unwrap_err();
        eprintln!("synthetic client error before connection: {:?}", error.code);
        let partial_body_sent = server.finish();
        assert_eq!(error.code, crate::ErrorCode::Network);
        assert!(
            !partial_body_sent,
            "invalid URL must not reach the fixture listener"
        );
    }

    #[tokio::test]
    async fn failed_download_cleans_staging_for_a_retry() {
        use std::{
            io::{Read, Write},
            net::TcpListener,
            thread,
        };

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request);
            stream
                .write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n")
                .unwrap();
        });

        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let installer = Installer::new(library.clone()).unwrap();
        let request = InstallRequest {
            port_id: "sample".into(),
            output_root: library.versions_dir().join("sample"),
            release: ResolvedRelease {
                version: "v1".into(),
                channel: crate::ReleaseChannel::Stable,
                published_at: None,
                asset: crate::ReleaseAsset {
                    name: "sample.zip".into(),
                    url: format!("http://{address}/sample.zip"),
                    size: 1,
                    sha256: "0".repeat(64),
                },
            },
            activate: true,
            managed: None,
            qualification: InstallQualification::test("sample-game.exe"),
        };

        let operation = OperationCoordinator::new("install", None);
        let error = installer
            .install(request, &operation, |_| {})
            .await
            .unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Network);
        server.join().unwrap();
        assert_eq!(fs::read_dir(library.staging_dir()).unwrap().count(), 0);
    }

    async fn assert_failed_install_cleanup_recovery(
        cleanup_point: LifecycleFaultPoint,
        staging_survives_failure: bool,
    ) {
        use std::{
            io::{Read, Write},
            net::TcpListener,
            thread,
        };

        let temporary = tempfile::tempdir().unwrap();
        let archive_path = temporary.path().join("test.zip");
        let archive = File::create(&archive_path).unwrap();
        let mut writer = zip::ZipWriter::new(archive);
        writer
            .start_file("sample-game.exe", zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"verified executable").unwrap();
        writer.finish().unwrap();
        let archive_bytes = fs::read(&archive_path).unwrap();
        let sha256 = hex::encode(Sha256::digest(&archive_bytes));
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let response_bytes = archive_bytes.clone();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request);
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                response_bytes.len()
            )
            .unwrap();
            stream.write_all(&response_bytes).unwrap();
        });
        let library = Library::open(temporary.path().join("library")).unwrap();
        let installer = Installer::with_faults(
            library.clone(),
            Arc::new(FailSequence {
                points: Mutex::new(vec![
                    LifecycleFaultPoint::InstallReadyToPublish,
                    cleanup_point,
                ]),
            }),
        )
        .unwrap();
        let operation = OperationCoordinator::new("install", None);
        let operation_id = operation.operation_id().to_owned();
        let request = InstallRequest {
            port_id: "sample".into(),
            output_root: library.versions_dir().join("sample"),
            release: ResolvedRelease {
                version: "v1".into(),
                channel: crate::ReleaseChannel::Stable,
                published_at: None,
                asset: crate::ReleaseAsset {
                    name: "test.zip".into(),
                    url: format!("http://{address}/test.zip"),
                    size: archive_bytes.len() as u64,
                    sha256,
                },
            },
            activate: true,
            managed: None,
            qualification: InstallQualification::test("sample-game.exe"),
        };

        let error = installer
            .install(request, &operation, |_| {})
            .await
            .unwrap_err();
        server.join().unwrap();
        assert_eq!(error.details.get("operation_id"), Some(&operation_id));
        assert_eq!(
            error.details.get("cleanup_state").map(String::as_str),
            Some("recovery_required")
        );
        let retained = OperationStore::new(library.clone()).all().unwrap();
        assert_eq!(retained.len(), 1);
        assert_eq!(retained[0].id, operation_id);
        assert_eq!(retained[0].phase, LifecyclePhase::CleanupPending);
        assert!(retained[0].install.is_none());
        assert!(
            retained[0]
                .last_error
                .as_deref()
                .unwrap()
                .contains("InstallReadyToPublish")
        );
        let staging = retained[0].paths.staging.clone().unwrap();
        assert_eq!(staging.exists(), staging_survives_failure);

        let retry = crate::PortcoveService::with_faults(
            library.clone(),
            Arc::new(FailOnce {
                point: cleanup_point,
                fired: AtomicBool::new(false),
            }),
        )
        .unwrap();
        retry.recover_lifecycle_operations_for_test().unwrap();
        let retained_after_retry = OperationStore::new(library.clone()).all().unwrap();
        assert_eq!(retained_after_retry.len(), 1);
        let retry_error = retained_after_retry[0].last_error.as_deref().unwrap();
        assert!(retry_error.contains("InstallReadyToPublish"));
        assert!(retry_error.contains("cleanup retry failed"));
        assert_eq!(staging.exists(), staging_survives_failure);

        crate::database::connect(library.root())
            .unwrap()
            .execute(
                "UPDATE lifecycle_operations SET updated_at=1 WHERE id=?1",
                [&operation_id],
            )
            .unwrap();
        let same_retry = crate::PortcoveService::with_faults(
            library.clone(),
            Arc::new(FailOnce {
                point: cleanup_point,
                fired: AtomicBool::new(false),
            }),
        )
        .unwrap();
        same_retry.recover_lifecycle_operations_for_test().unwrap();
        let unchanged = OperationStore::new(library.clone())
            .get(&operation_id)
            .unwrap()
            .unwrap();
        assert_eq!(unchanged.last_error.as_deref(), Some(retry_error));
        assert_eq!(
            unchanged.updated_at, 1,
            "identical retry must not rewrite the journal"
        );

        let changed_retry = crate::PortcoveService::with_faults(
            library.clone(),
            Arc::new(FailWithMessage {
                point: cleanup_point,
                message: "different retry cause",
            }),
        )
        .unwrap();
        changed_retry
            .recover_lifecycle_operations_for_test()
            .unwrap();
        let changed = OperationStore::new(library.clone())
            .get(&operation_id)
            .unwrap()
            .unwrap();
        let changed_error = changed.last_error.as_deref().unwrap();
        assert!(changed_error.contains("InstallReadyToPublish"));
        assert!(changed_error.ends_with("different retry cause"));
        assert_eq!(changed_error.matches("cleanup retry failed").count(), 1);

        crate::PortcoveService::new(library.clone()).unwrap();
        assert!(!staging.exists());
        assert!(OperationStore::new(library).all().unwrap().is_empty());
    }

    #[tokio::test]
    async fn failed_private_install_cleanup_is_retained_and_retried_on_restart() {
        assert_failed_install_cleanup_recovery(LifecycleFaultPoint::InstallPrivateCleanup, true)
            .await;
    }

    #[tokio::test]
    async fn failed_private_install_journal_retirement_is_retried_on_restart() {
        assert_failed_install_cleanup_recovery(
            LifecycleFaultPoint::InstallPrivateCleanupJournalRemoval,
            false,
        )
        .await;
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn cvlod_legacy_publication_and_recovery_preserve_untracked_cleanup() {
        use std::{
            io::{Read, Write},
            net::TcpListener,
            thread,
        };
        for interrupted in [false, true] {
            let temporary = tempfile::tempdir().unwrap();
            let archive_path = temporary.path().join("legacy.zip");
            let mut writer = zip::ZipWriter::new(File::create(&archive_path).unwrap());
            writer
                .start_file("sample-game.exe", zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(b"verified legacy fixture").unwrap();
            writer.finish().unwrap();
            let archive_bytes = fs::read(&archive_path).unwrap();
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let address = listener.local_addr().unwrap();
            let response = archive_bytes.clone();
            let stopped = Arc::new(AtomicBool::new(false));
            let server_stop = Arc::clone(&stopped);
            let server = thread::spawn(move || {
                let (mut stream, _) = loop {
                    if server_stop.load(Ordering::Acquire) {
                        return false;
                    }
                    match listener.accept() {
                        Ok(connection) => break connection,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(5));
                        }
                        Err(error) => panic!("legacy fixture accept failed: {error}"),
                    }
                };
                // Windows inherits the listener's nonblocking socket mode.
                // Wait for the actual bounded request before replying/closing.
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                stream
                    .set_write_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let deadline = std::time::Instant::now() + Duration::from_secs(2);
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    assert!(request.len() < 4096, "legacy fixture request header limit");
                    let remaining = deadline
                        .checked_duration_since(std::time::Instant::now())
                        .expect("legacy fixture request deadline");
                    stream.set_read_timeout(Some(remaining)).unwrap();
                    let mut byte = [0];
                    stream
                        .read_exact(&mut byte)
                        .expect("legacy fixture complete request headers");
                    request.push(byte[0]);
                }
                assert!(request.starts_with(b"GET /legacy.zip HTTP/1.1\r\n"));
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    response.len()
                )
                .unwrap();
                stream.write_all(&response).unwrap();
                true
            });
            let library = Library::open(temporary.path().join("library")).unwrap();
            let installer = if interrupted {
                Installer::with_faults(
                    library.clone(),
                    Arc::new(FailOnce {
                        point: LifecycleFaultPoint::InstallMetadataCommitted,
                        fired: AtomicBool::new(false),
                    }),
                )
                .unwrap()
            } else {
                Installer::new(library.clone()).unwrap()
            };
            let request = InstallRequest {
                port_id: "cvlod-recomp".into(),
                output_root: library.versions_dir().join("cvlod-recomp"),
                release: ResolvedRelease {
                    version: "legacy-fixture".into(),
                    channel: crate::ReleaseChannel::Stable,
                    published_at: None,
                    asset: crate::ReleaseAsset {
                        name: "legacy.zip".into(),
                        url: format!("http://{address}/legacy.zip"),
                        size: archive_bytes.len() as u64,
                        sha256: hex::encode(Sha256::digest(&archive_bytes)),
                    },
                },
                activate: true,
                managed: None,
                qualification: InstallQualification::test_for_port(
                    "cvlod-recomp",
                    "sample-game.exe",
                ),
            };
            let result = installer
                .install(request, &OperationCoordinator::new("install", None), |_| {})
                .await;
            stopped.store(true, Ordering::Release);
            assert!(
                server.join().unwrap(),
                "legacy request was not served: {result:?}"
            );
            let store = OperationStore::new(library.clone());
            if interrupted {
                assert!(
                    result
                        .unwrap_err()
                        .message
                        .contains("injected lifecycle failure")
                );
                let retained = store.all().unwrap();
                assert_eq!(retained.len(), 1);
                assert_eq!(retained[0].phase, LifecyclePhase::MetadataCommitted);
                assert_eq!(retained[0].preparation_process_quiesced, None);
                crate::PortcoveService::new(library.clone()).unwrap();
            } else {
                assert!(result.unwrap().verified);
            }
            assert!(store.all().unwrap().is_empty());
            assert_eq!(fs::read_dir(library.staging_dir()).unwrap().count(), 0);
            let install = library
                .install_by_version("cvlod-recomp", "legacy-fixture")
                .unwrap()
                .unwrap();
            assert_eq!(
                fs::read(install.path.join("sample-game.exe")).unwrap(),
                b"verified legacy fixture"
            );
            assert!(
                Installer::new(library.clone())
                    .unwrap()
                    .verify(&install)
                    .unwrap()
                    .valid
            );
            assert_eq!(fs::read(&archive_path).unwrap(), archive_bytes);
        }
    }

    async fn assert_external_install_recovery(point: LifecycleFaultPoint) {
        assert_external_install_destination_recovery(point, None).await;
    }

    async fn assert_external_install_destination_recovery(
        point: LifecycleFaultPoint,
        destination_case: Option<(LifecyclePhase, bool)>,
    ) {
        use std::{
            io::{Read, Write},
            net::TcpListener,
            thread,
        };

        let temporary = tempfile::tempdir().unwrap();
        let archive_path = temporary.path().join("test.zip");
        let archive = File::create(&archive_path).unwrap();
        let mut writer = zip::ZipWriter::new(archive);
        writer
            .start_file("sample-game.exe", zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"verified executable").unwrap();
        writer.finish().unwrap();
        let archive_bytes = fs::read(&archive_path).unwrap();
        let sha256 = hex::encode(Sha256::digest(&archive_bytes));
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let response_bytes = archive_bytes.clone();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request);
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                response_bytes.len()
            )
            .unwrap();
            stream.write_all(&response_bytes).unwrap();
        });
        let library = Library::open(temporary.path().join("library")).unwrap();
        let output_root = temporary.path().join("external-output");
        let installer = Installer::with_faults(
            library.clone(),
            Arc::new(FailOnce {
                point,
                fired: AtomicBool::new(false),
            }),
        )
        .unwrap();
        let operation = OperationCoordinator::new("install", None);
        let request = InstallRequest {
            port_id: "sample".into(),
            output_root: output_root.clone(),
            release: ResolvedRelease {
                version: "v1".into(),
                channel: crate::ReleaseChannel::Stable,
                published_at: None,
                asset: crate::ReleaseAsset {
                    name: "test.zip".into(),
                    url: format!("http://{address}/test.zip"),
                    size: archive_bytes.len() as u64,
                    sha256,
                },
            },
            activate: true,
            managed: None,
            qualification: InstallQualification::test("sample-game.exe"),
        };

        let error = installer
            .install(request, &operation, |_| {})
            .await
            .unwrap_err();
        assert!(error.message.contains("injected lifecycle failure"));
        server.join().unwrap();

        if let Some((phase, omitted)) = destination_case {
            let store = OperationStore::new(library.clone());
            let mut journal = store.all().unwrap().pop().unwrap();
            let destination = journal.paths.final_path.clone().unwrap();
            let staging = journal.paths.staging.clone().unwrap();
            let private = staging.join("destination-sentinel");
            fs::write(&private, b"private install evidence").unwrap();
            let unrelated = temporary.path().join("unrelated-destination");
            fs::create_dir_all(&unrelated).unwrap();
            fs::write(unrelated.join("sentinel"), b"unrelated original").unwrap();
            let payload = fs::read(staging.join("payload/sample-game.exe")).ok();
            let published = fs::read(destination.join("sample-game.exe")).ok();
            let registered = serde_json::to_vec(&library.all_installs().unwrap()).unwrap();
            journal.phase = phase;
            journal.paths.final_path = (!omitted).then(|| unrelated.clone());
            store.put(&mut journal).unwrap();
            if !omitted {
                crate::PortcoveService::new(library.clone()).unwrap();
                let retained = store.get(&journal.id).unwrap().unwrap();
                assert_eq!(retained.phase, phase);
                assert_eq!(retained.paths.final_path, Some(unrelated.clone()));
                assert_eq!(
                    serde_json::to_vec(&retained.install).unwrap(),
                    serde_json::to_vec(&journal.install).unwrap()
                );
                assert!(retained.last_error.unwrap().contains("journal destination"));
                assert_eq!(fs::read(&private).unwrap(), b"private install evidence");
                assert_eq!(
                    fs::read(staging.join("payload/sample-game.exe")).ok(),
                    payload
                );
                assert_eq!(
                    fs::read(destination.join("sample-game.exe")).ok(),
                    published
                );
                assert_eq!(
                    serde_json::to_vec(&library.all_installs().unwrap()).unwrap(),
                    registered
                );
                assert_eq!(fs::read(&archive_path).unwrap(), archive_bytes);
                journal = store.get(&journal.id).unwrap().unwrap();
                journal.paths.final_path = Some(destination);
                store.put(&mut journal).unwrap();
            }
            crate::PortcoveService::new(library.clone()).unwrap();
            assert!(!staging.exists());
            assert_eq!(
                fs::read(unrelated.join("sentinel")).unwrap(),
                b"unrelated original"
            );
        }

        crate::PortcoveService::new(library.clone()).unwrap();
        let install = library.install_by_version("sample", "v1").unwrap().unwrap();
        assert_eq!(
            install.path.parent(),
            Some(fs::canonicalize(&output_root).unwrap().as_path())
        );
        assert!(install.path.join("sample-game.exe").is_file());
        assert!(output_root.join(".portcove-game-output.json").is_file());
        assert!(OperationStore::new(library).all().unwrap().is_empty());
    }

    #[tokio::test]
    async fn external_install_recovery_retains_contradictory_destinations() {
        for (point, phase) in [
            (
                LifecycleFaultPoint::InstallPrepared,
                LifecyclePhase::Prepared,
            ),
            (
                LifecycleFaultPoint::InstallPublished,
                LifecyclePhase::PayloadPublished,
            ),
            (
                LifecycleFaultPoint::InstallMetadataCommitted,
                LifecyclePhase::MetadataCommitted,
            ),
            (
                LifecycleFaultPoint::InstallMetadataCommitted,
                LifecyclePhase::CleanupPending,
            ),
        ] {
            assert_external_install_destination_recovery(point, Some((phase, false))).await;
        }
    }

    #[tokio::test]
    async fn external_install_recovery_preserves_omitted_destination_compatibility() {
        for (point, phase) in [
            (
                LifecycleFaultPoint::InstallPublished,
                LifecyclePhase::PayloadPublished,
            ),
            (
                LifecycleFaultPoint::InstallMetadataCommitted,
                LifecyclePhase::CleanupPending,
            ),
        ] {
            assert_external_install_destination_recovery(point, Some((phase, true))).await;
        }
    }

    #[tokio::test]
    async fn external_install_recovers_after_prepared() {
        assert_external_install_recovery(LifecycleFaultPoint::InstallPrepared).await;
    }

    #[tokio::test]
    async fn external_install_recovers_after_published() {
        assert_external_install_recovery(LifecycleFaultPoint::InstallPublished).await;
    }

    #[tokio::test]
    async fn external_install_recovers_after_metadata_committed() {
        assert_external_install_recovery(LifecycleFaultPoint::InstallMetadataCommitted).await;
    }
}
