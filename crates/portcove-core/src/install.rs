use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use crate::{
    AdapterKind, ArtifactIdentity, BundledRuntime, InstallRecord, Library, OperationCoordinator,
    OperationEvent, Platform, PortDefinition, PortcoveError, PsxManagedPreparation, ReleaseAsset,
    ResolvedRelease, Result, RuntimeIdentity, RuntimeOrigin,
    adapter::{hash_file, walk_files},
    archive::{extract_archive, validate_download_progress, validate_download_size},
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
    pub activate: bool,
    pub managed: Option<PsxManagedPreparation>,
    pub qualification: InstallQualification,
}

#[derive(Debug, Clone)]
pub struct InstallQualification {
    platform: Platform,
    executable_hints: Vec<String>,
    runtime_subdirectory: Option<String>,
    persistent_paths: Vec<String>,
    persistent_file_patterns: Vec<crate::PersistentFilePattern>,
    runtime_mutable_paths: Vec<String>,
    persistence_at_install_root: bool,
    runtime: Option<BundledRuntime>,
    runtime_origin: RuntimeOrigin,
    generated_metadata: Vec<String>,
    critical_paths: Vec<String>,
}

impl InstallQualification {
    pub fn from_port(port: &PortDefinition, platform: Platform) -> Result<Self> {
        crate::runtime::validate(port)?;
        for pattern in &port.persistent_file_patterns {
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
            platform,
            executable_hints,
            runtime_subdirectory: port.runtime_subdirectory.clone(),
            persistent_paths: port.persistent_paths.clone(),
            persistent_file_patterns: port.persistent_file_patterns.clone(),
            runtime_mutable_paths: port.runtime_mutable_paths.clone(),
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

    fn runtime_mutable_paths(&self, install: &InstallRecord) -> Result<Vec<String>> {
        let working = self.runtime_root(
            &install.path,
            &install.path.join(&install.selected_executable),
        );
        self.runtime_mutable_paths
            .iter()
            .map(|relative| manifest_relative(&install.path, &working.join(relative)))
            .collect()
    }

    fn file_patterns(&self, root: &Path, selected: &Path) -> Result<Vec<ManifestFilePattern>> {
        let working = self.persistence_root(root, selected);
        let directory = if working == root {
            None
        } else {
            Some(manifest_relative(root, &working)?)
        };
        Ok(self
            .persistent_file_patterns
            .iter()
            .map(|pattern| ManifestFilePattern {
                directory: directory.clone(),
                pattern: pattern.clone(),
            })
            .collect())
    }

    #[cfg(test)]
    pub(crate) fn with_test_runtime_url(mut self, url: String) -> Self {
        self.runtime.as_mut().expect("test runtime").asset.url = url;
        self
    }

    #[cfg(test)]
    pub(crate) fn test(executable: &str) -> Self {
        Self {
            platform: Platform::WindowsX86_64,
            executable_hints: vec![executable.into()],
            runtime_subdirectory: None,
            persistent_paths: Vec::new(),
            persistent_file_patterns: Vec::new(),
            runtime_mutable_paths: Vec::new(),
            persistence_at_install_root: true,
            runtime: None,
            runtime_origin: RuntimeOrigin::VerifiedDownload,
            generated_metadata: Vec::new(),
            critical_paths: Vec::new(),
        }
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
}

#[derive(Clone)]
pub struct Installer {
    library: Library,
    client: reqwest::Client,
    faults: Arc<dyn LifecycleFaultInjector>,
}

struct InstallLifecycle {
    destination: std::path::PathBuf,
    operation_root: std::path::PathBuf,
    store: OperationStore,
    record: LifecycleOperation,
}

impl Installer {
    pub fn new(library: Library) -> Result<Self> {
        let client = reqwest::Client::builder()
            .user_agent(concat!("Portcove/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|error| PortcoveError::network(error.to_string()))?;
        Ok(Self {
            library,
            client,
            faults: Arc::new(NoLifecycleFaults),
        })
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
        let mut storage_key = artifact_storage_key(&request.release.asset.sha256)?;
        if let Some(runtime) = &request.qualification.runtime {
            storage_key = hex::encode(Sha256::digest(serde_json::to_vec(&(
                "Portcove composite installation v1",
                storage_key,
                runtime.identity(),
            ))?));
        }
        let destination = self
            .library
            .versions_dir()
            .join(&request.port_id)
            .join(&storage_key);
        if destination.exists() {
            return Err(PortcoveError::conflict(format!(
                "version {} already exists for {}",
                request.release.version, request.port_id
            )));
        }
        let operation_root = self.library.staging_dir().join(operation.operation_id());
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
        let result = self
            .install_inner(request, operation, &mut lifecycle, &mut emit)
            .await;
        if let Err(error) = &result {
            if lifecycle.record.phase == LifecyclePhase::Preparing {
                if error.code == crate::ErrorCode::Cancelled {
                    if let Err(cleanup) = crate::cancellation::discard_private_install(
                        &self.library,
                        &lifecycle.record,
                    ) {
                        return Err(PortcoveError::new(crate::ErrorCode::Cancelled,
                            "Publication was cancelled; private preparation cleanup requires review")
                            .detail("operation_id", lifecycle.record.id).detail("cleanup_error", cleanup.message));
                    }
                    return result;
                }
                let _ = fs::remove_dir_all(&lifecycle.operation_root);
                let _ = lifecycle.store.remove(&lifecycle.record.id);
            } else {
                lifecycle.record.last_error = Some(error.message.clone());
                let _ = lifecycle.store.put(&mut lifecycle.record);
            }
        }
        result
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
            )
            .await?;
        if let Some(runtime) = &request.qualification.runtime {
            let unpacked = lifecycle.operation_root.join("runtime");
            fs::create_dir_all(&unpacked)?;
            self.prepare_asset(
                &runtime.asset,
                &lifecycle.operation_root.join("runtime.download"),
                &unpacked,
                operation,
                emit,
            )
            .await?;
            let source = unpacked.join(&runtime.archive_root);
            crate::runtime::require_executable(&source, runtime)?;
            let selected = resolve_declared_executable(&payload_root, &request.qualification)?;
            let destination = request
                .qualification
                .runtime_root(&payload_root, &selected)
                .join(&runtime.target_directory);
            crate::runtime::require_vacant(
                destination.parent().expect("runtime has parent"),
                &runtime.target_directory,
            )?;
            fs::rename(source, destination)?;
            operation.checkpoint()?;
        }
        if let Some(preparation) = request.managed.clone() {
            emit(operation.message("info", "Generating and compiling the verified PS1 source"));
            let managed_root = payload_root.clone();
            tokio::task::spawn_blocking(move || {
                crate::psx::prepare_install(&managed_root, &preparation)
            })
            .await
            .map_err(|error| PortcoveError::install(error.to_string()))??;
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
            port_id: request.port_id,
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
            fs::rename(&payload_root, &lifecycle.destination)?;
        }
        lifecycle.record.phase = LifecyclePhase::PayloadPublished;
        lifecycle.store.put(&mut lifecycle.record)?;
        self.faults.check(LifecycleFaultPoint::InstallPublished)?;
        self.library.register_install(&install, request.activate)?;
        lifecycle.record.phase = LifecyclePhase::MetadataCommitted;
        lifecycle.store.put(&mut lifecycle.record)?;
        self.faults
            .check(LifecycleFaultPoint::InstallMetadataCommitted)?;
        if let Err(error) = fs::remove_dir_all(&lifecycle.operation_root) {
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
    ) -> Result<ArtifactIdentity>
    where
        F: FnMut(OperationEvent),
    {
        self.download(asset, download_path, operation, emit).await?;
        let (actual_hash, actual_size) =
            crate::adapter::hash_file_with_checkpoint(download_path, || operation.checkpoint())?;
        if !actual_hash.eq_ignore_ascii_case(&asset.sha256) {
            return Err(PortcoveError::verification(
                "downloaded asset failed SHA-256 verification",
            )
            .detail("asset", &asset.name)
            .detail("expected", &asset.sha256)
            .detail("actual", actual_hash));
        }
        emit(operation.message("info", format!("SHA-256 verified: {}", asset.name)));
        let asset_name = asset.name.clone();
        let extraction_path = download_path.to_path_buf();
        let extraction_root = payload_root.to_path_buf();
        let expected_size = asset.size;
        tokio::task::spawn_blocking(move || {
            extract_asset(
                &extraction_path,
                &extraction_root,
                &asset_name,
                expected_size,
            )
        })
        .await
        .map_err(|error| PortcoveError::install(error.to_string()))??;
        operation.checkpoint()?;
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
        validate_download_progress(0, asset.size)?;
        let response = operation
            .interruptible(async {
                self.client
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
        self.verify_with_metadata(install, &[], &[])
    }

    pub(crate) fn verify_managed(
        &self,
        install: &InstallRecord,
        qualification: &InstallQualification,
    ) -> Result<VerificationReport> {
        self.verify_with_metadata(
            install,
            &qualification.generated_metadata_paths(install)?,
            &qualification.runtime_mutable_paths(install)?,
        )
    }

    fn verify_with_metadata(
        &self,
        install: &InstallRecord,
        generated_metadata: &[String],
        current_runtime_mutable_paths: &[String],
    ) -> Result<VerificationReport> {
        let manifest = verified_manifest(install)?;
        let mut failures = Vec::new();
        for file in &manifest.files {
            let candidate = manifest_member(&install.path, &file.path)?;
            if !candidate.is_file() {
                failures.push(format!("missing: {}", file.path));
                continue;
            }
            let (sha256, size) = hash_file(&candidate)?;
            if size != file.size || sha256 != file.sha256 {
                failures.push(format!("changed: {}", file.path));
            }
        }
        let expected = manifest
            .files
            .iter()
            .map(|file| file.path.as_str())
            .collect::<std::collections::BTreeSet<_>>();
        for candidate in walk_files(&install.path)? {
            let relative = manifest_relative(&install.path, &candidate)?;
            if relative == ".portcove-manifest.json"
                || relative == ".portcove-launched"
                || generated_metadata.contains(&relative)
                || current_runtime_mutable_paths.iter().any(|mutable| {
                    relative == *mutable || relative.starts_with(&format!("{mutable}/"))
                })
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

    pub(crate) fn verify_critical(&self, install: &InstallRecord) -> Result<PathBuf> {
        let manifest = verified_manifest(install)?;
        let mut failures = Vec::new();
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
        for file in manifest.files.iter().filter(|file| file.critical) {
            let candidate = manifest_member(&install.path, &file.path)?;
            if !candidate.is_file() {
                failures.push(format!("missing: {}", file.path));
                continue;
            }
            let (sha256, size) = hash_file(&candidate)?;
            if size != file.size || sha256 != file.sha256 {
                failures.push(format!("changed: {}", file.path));
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
        let executable = install.path.join(&install.selected_executable);
        if !executable.starts_with(&install.path) || !executable.is_file() {
            return Err(PortcoveError::verification(
                "selected executable escaped or disappeared from its install",
            ));
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
        let selected = resolve_declared_executable(&install.path, qualification)?;
        let (files, mutable_paths) = manifest_files(&install.path, qualification, &selected)?;
        let generated_metadata = qualification.generated_metadata_paths(install)?;
        let mut expected_mutable = manifest.mutable_paths.clone();
        expected_mutable.extend(generated_metadata.iter().cloned());
        expected_mutable.extend(qualification.runtime_mutable_paths(install)?);
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

    pub(crate) fn refresh_verified_manifest(
        &self,
        install: &InstallRecord,
        qualification: &InstallQualification,
    ) -> Result<InstallRecord> {
        let (manifest_sha256, selected_executable, runtime) = write_manifest(
            &install.id,
            &install.port_id,
            &install.version,
            &install.artifact,
            qualification,
            &install.path,
        )?;
        let mut refreshed = install.clone();
        refreshed.manifest_sha256 = manifest_sha256;
        refreshed.selected_executable = selected_executable;
        refreshed.runtime = runtime;
        Ok(refreshed)
    }
}

fn write_manifest(
    install_id: &str,
    port_id: &str,
    version: &str,
    artifact: &ArtifactIdentity,
    qualification: &InstallQualification,
    root: &Path,
) -> Result<(String, PathBuf, Option<RuntimeIdentity>)> {
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
        schema_version: 4,
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
        crate::runtime::require_executable(runtime_root.as_ref().expect("runtime root"), runtime)?;
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
                || is_critical_companion(&path, selected)
                || runtime_root
                    .as_ref()
                    .is_some_and(|runtime| path.starts_with(runtime)))
        {
            return Err(PortcoveError::verification(
                "persistent file pattern matched executable or bootstrap content",
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
                || is_critical_companion(&path, selected)
                || critical_roots
                    .iter()
                    .any(|critical| path == *critical || path.starts_with(critical))
                || runtime_root
                    .as_ref()
                    .is_some_and(|runtime| path.starts_with(runtime)),
            path: relative,
            size,
            sha256,
        });
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok((files, mutable_paths))
}

fn verified_manifest(install: &InstallRecord) -> Result<InstallManifest> {
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
    let bytes = fs::read(&manifest_path).map_err(|_| {
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
                "persistent file pattern overlaps the executable or immutable runtime",
            ));
        }
    }
    if !matches!(manifest.schema_version, 2..=4)
        || (manifest.schema_version < 4 && !manifest.mutable_file_patterns.is_empty())
        || (manifest.schema_version == 2 && manifest.runtime.is_some())
        || manifest.runtime != install.runtime
        || manifest.install_id != install.id
        || manifest.port_id != install.port_id
        || manifest.version != install.version
        || manifest.artifact != install.artifact
        || manifest.selected_executable != selected
        || !manifest
            .files
            .iter()
            .any(|file| file.path == selected && file.critical)
    {
        return Err(PortcoveError::verification(
            "install manifest identity does not match the registered install",
        ));
    }
    validate_runtime_manifest(&manifest)?;
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
    if !manifest
        .files
        .iter()
        .any(|file| file.path == executable && file.critical)
        || manifest.files.iter().any(|file| !file.critical)
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
    let files = walk_files(&search_root)?;
    for hint in &qualification.executable_hints {
        if let Some(found) = files.iter().find(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.eq_ignore_ascii_case(hint))
        }) {
            return Ok(found.clone());
        }
    }
    Err(PortcoveError::verification(format!(
        "none of the declared executables for {:?} were found",
        qualification.platform
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

fn is_critical_companion(path: &Path, selected: &Path) -> bool {
    if path.parent() != selected.parent() {
        return false;
    }
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("dll" | "so" | "dylib" | "bat" | "cmd" | "sh" | "toml" | "ini" | "cfg")
    )
}

fn extract_asset(
    source: &Path,
    destination: &Path,
    asset_name: &str,
    expected_size: u64,
) -> Result<()> {
    let lower = asset_name.to_ascii_lowercase();
    if lower.ends_with(".zip") || lower.ends_with(".tar.gz") || lower.ends_with(".tgz") {
        extract_archive(source, destination, asset_name, expected_size)
    } else if lower.ends_with(".exe") || lower.ends_with(".appimage") {
        let target = destination.join(asset_name);
        fs::copy(source, &target)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = fs::metadata(&target)?.permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(&target, permissions)?;
        }
        Ok(())
    } else {
        Err(PortcoveError::unsupported(format!(
            "unsupported package format: {asset_name}"
        )))
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs::File,
        sync::atomic::{AtomicBool, Ordering},
    };

    use sha2::{Digest, Sha256};

    use super::*;

    struct FailOnce {
        point: LifecycleFaultPoint,
        fired: AtomicBool,
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
        let qualification = InstallQualification::from_port(
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
        let qualification = InstallQualification::from_port(
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
        let qualification = InstallQualification::from_port(
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
        let installer = Installer::new(library).unwrap();
        let request = InstallRequest {
            port_id: "sample".into(),
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

    #[tokio::test]
    async fn install_recovers_after_every_publication_boundary() {
        use std::{
            io::{Read, Write},
            net::TcpListener,
            thread,
        };

        for point in [
            LifecycleFaultPoint::InstallPrepared,
            LifecycleFaultPoint::InstallPublished,
            LifecycleFaultPoint::InstallMetadataCommitted,
        ] {
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
                Arc::new(FailOnce {
                    point,
                    fired: AtomicBool::new(false),
                }),
            )
            .unwrap();
            let operation = OperationCoordinator::new("install", None);
            let request = InstallRequest {
                port_id: "sample".into(),
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

            crate::PortcoveService::new(library.clone()).unwrap();
            let install = library.install_by_version("sample", "v1").unwrap().unwrap();
            assert!(install.path.join("sample-game.exe").is_file());
            assert!(OperationStore::new(library).all().unwrap().is_empty());
        }
    }
}
