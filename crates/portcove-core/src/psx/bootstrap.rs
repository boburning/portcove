//! Acquired setup bytes only. This witness grants no tool or game execution.
use std::{fs, path::PathBuf};

use serde::{Deserialize, Serialize};

use super::{PsxManagedPreparation, PsxStageWitness, preparation_identity, stage::GeneratedTree};
use crate::operation::{LifecycleOperation, LifecycleOperationKind, LifecyclePhase};
use crate::{ArtifactIdentity, Library, OperationCoordinator, PortcoveError, Result};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct BootstrapWitness {
    schema_version: u32,
    library_root: PathBuf,
    library_id: String,
    port_id: String,
    final_path: Option<PathBuf>,
    activate: bool,
    created_at: i64,
    contract: serde_json::Value,
    inputs: Vec<u8>,
    artifact: ArtifactIdentity,
    archive: crate::external_runtime::InspectedFile,
    payload: GeneratedTree,
    #[serde(skip)]
    persisted_sha256: Option<String>,
    #[serde(skip)]
    persisted_json: Option<String>,
}

/// Exact acquired predecessor bytes, retained throughout all later stages.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct BootstrapBinding {
    sha256: String,
    json: String,
}

impl BootstrapBinding {
    pub(super) fn receipt(&self) -> (&str, &str) {
        (&self.sha256, &self.json)
    }

    pub(super) fn require_current(&self, library: &Library, operation_id: &str) -> Result<()> {
        use sha2::Digest;
        if self.json.len() > 64 * 1024 * 1024
            || hex::encode(sha2::Sha256::digest(self.json.as_bytes())) != self.sha256
        {
            return Err(PortcoveError::verification(
                "PS1 acquired predecessor bytes changed",
            ));
        }
        let current: bool = library.connection()?.query_row(
            "SELECT EXISTS(SELECT 1 FROM managed_psx_bootstrap WHERE operation_id=?1 AND witness_sha256=?2 AND witness_json=?3)",
            rusqlite::params![operation_id, self.sha256, self.json], |row| row.get(0),
        )?;
        if !current {
            return Err(PortcoveError::conflict("PS1 acquired predecessor changed"));
        }
        Ok(())
    }
}

impl BootstrapWitness {
    pub(crate) fn contract(&self) -> &serde_json::Value {
        &self.contract
    }

    pub(super) fn payload(&self) -> &GeneratedTree {
        &self.payload
    }

    pub(super) fn verify_archive(
        &self,
        library: &Library,
        journal: &LifecycleOperation,
        operation: &OperationCoordinator,
    ) -> Result<()> {
        self.require_context(library, journal, operation)?;
        let staging = journal
            .paths
            .staging
            .as_ref()
            .expect("context checked staging");
        let archive = crate::external_runtime::hash_stable_file(
            &archive_path(staging)?,
            self.artifact.size,
            &|| operation.checkpoint(),
        )?;
        if archive != self.archive || archive.sha256 != self.artifact.sha256 {
            return Err(PortcoveError::verification("PS1 bootstrap archive changed"));
        }
        operation.checkpoint()
    }

    pub(crate) fn require_current_parent(
        &self,
        library: &Library,
        operation: &OperationCoordinator,
    ) -> Result<()> {
        self.binding()?
            .require_current(library, operation.operation_id())
    }

    /// Validate decoded ownership only. This is not fresh content verification
    /// and cannot authorize a helper, generator or successful checkpoint.
    pub(crate) fn verify_context(
        &self,
        library: &Library,
        journal: &LifecycleOperation,
        operation: &OperationCoordinator,
    ) -> Result<()> {
        self.require_context(library, journal, operation)
    }

    pub(super) fn payload_root(&self) -> &std::path::Path {
        self.payload.root()
    }

    pub(super) fn require_preparation(&self, preparation: &PsxManagedPreparation) -> Result<()> {
        if self.inputs != preparation_identity(preparation)? {
            return Err(PortcoveError::conflict("PS1 acquired preparation changed"));
        }
        Ok(())
    }

    pub(crate) fn capture(
        library: &Library,
        journal: &LifecycleOperation,
        contract: serde_json::Value,
        preparation: &PsxManagedPreparation,
        artifact: ArtifactIdentity,
        operation: &OperationCoordinator,
    ) -> Result<Self> {
        let staging = journal
            .paths
            .staging
            .as_ref()
            .ok_or_else(|| PortcoveError::state("PS1 bootstrap has no staging owner"))?;
        let archive = crate::external_runtime::hash_stable_file(
            &archive_path(staging)?,
            artifact.size,
            &|| operation.checkpoint(),
        )?;
        if archive.sha256 != artifact.sha256 || archive.size() != artifact.size {
            return Err(PortcoveError::verification(
                "PS1 bootstrap archive differs from acquisition",
            ));
        }
        let payload = GeneratedTree::capture(&staging.join("payload"), operation, true)?;
        crate::path::refuse_symlink_ancestors(library.root())?;
        let witness = Self {
            schema_version: 1,
            library_root: fs::canonicalize(library.root())?,
            library_id: library.identity()?,
            port_id: journal.port_id.clone(),
            final_path: journal.paths.final_path.clone(),
            activate: journal.activate,
            created_at: journal.created_at,
            contract,
            inputs: preparation_identity(preparation)?,
            artifact,
            archive,
            payload,
            persisted_sha256: None,
            persisted_json: None,
        };
        // Provisional observations only; the joined owner must verify and
        // atomically seal this value after durable positive worker closure.
        Ok(witness)
    }

    pub(crate) fn port_id(&self) -> &str {
        &self.port_id
    }

    pub(crate) fn artifact(&self) -> &ArtifactIdentity {
        &self.artifact
    }

    pub(crate) fn require_request(
        &self,
        contract: &serde_json::Value,
        preparation: &PsxManagedPreparation,
    ) -> Result<()> {
        if &self.contract != contract || self.inputs != preparation_identity(preparation)? {
            return Err(PortcoveError::conflict(
                "PS1 acquired continuation request changed",
            ));
        }
        Ok(())
    }

    pub(super) fn binding(&self) -> Result<BootstrapBinding> {
        Ok(BootstrapBinding {
            sha256: self.persisted_sha256.clone().ok_or_else(|| {
                PortcoveError::state("PS1 acquired predecessor was not store-loaded")
            })?,
            json: self.persisted_json.clone().ok_or_else(|| {
                PortcoveError::state("PS1 acquired predecessor bytes were not store-loaded")
            })?,
        })
    }

    pub(crate) fn generate(
        self,
        library: &Library,
        journal: &LifecycleOperation,
        preparation: &PsxManagedPreparation,
        operation: &OperationCoordinator,
    ) -> (Result<(super::GeneratedInstall, BootstrapBinding)>, bool) {
        let checked = self.binding().and_then(|binding| {
            crate::operation::OperationStore::new(library.clone())
                .require_psx_normalization_vacant(operation)?;
            binding.require_current(library, operation.operation_id())?;
            self.verify(library, journal, operation)?;
            Ok(binding)
        });
        let binding = match checked {
            Ok(value) => value,
            Err(error) => return (Err(error), true),
        };
        let (result, quiesced) =
            super::generate_install_stage(self.payload.root(), preparation, operation);
        (result.map(|generated| (generated, binding)), quiesced)
    }
}

impl PsxStageWitness for BootstrapWitness {
    fn record_load(&mut self, sha256: String) {
        self.persisted_sha256 = Some(sha256);
    }
    fn record_load_json(&mut self, json: String) {
        self.persisted_json = Some(json);
    }
    fn library_id(&self) -> &str {
        &self.library_id
    }

    fn verify(
        &self,
        library: &Library,
        journal: &LifecycleOperation,
        operation: &OperationCoordinator,
    ) -> Result<()> {
        self.require_context(library, journal, operation)?;
        let staging = journal
            .paths
            .staging
            .as_ref()
            .expect("context checked staging");
        let archive = crate::external_runtime::hash_stable_file(
            &archive_path(staging)?,
            self.artifact.size,
            &|| operation.checkpoint(),
        )?;
        if archive != self.archive || archive.sha256 != self.artifact.sha256 {
            return Err(PortcoveError::verification("PS1 bootstrap archive changed"));
        }
        self.payload.verify(&staging.join("payload"), operation)
    }
}

fn archive_path(staging: &std::path::Path) -> Result<PathBuf> {
    let path = staging.join("artifact.download");
    crate::path::refuse_symlink_ancestors(&path)?;
    Ok(fs::canonicalize(path)?)
}

impl BootstrapWitness {
    fn require_context(
        &self,
        library: &Library,
        journal: &LifecycleOperation,
        operation: &OperationCoordinator,
    ) -> Result<()> {
        if journal.last_error.is_some() {
            return Err(PortcoveError::state("PS1 bootstrap custody changed"));
        }
        self.require_closed_context(library, journal, operation)
    }

    pub(super) fn verify_generation_context(
        &self,
        library: &Library,
        predecessor: &crate::operation::ClosedGenerationPredecessor,
        operation: &OperationCoordinator,
    ) -> Result<()> {
        self.require_closed_context(library, predecessor.journal(), operation)
    }

    pub(super) fn verify_generation_predecessor(
        &self,
        library: &Library,
        predecessor: &crate::operation::ClosedGenerationPredecessor,
        operation: &OperationCoordinator,
    ) -> Result<()> {
        self.verify_generation_context(library, predecessor, operation)?;
        let staging = predecessor
            .journal()
            .paths
            .staging
            .as_ref()
            .expect("checked staging");
        let archive = crate::external_runtime::hash_stable_file(
            &archive_path(staging)?,
            self.artifact.size,
            &|| operation.checkpoint(),
        )?;
        if archive != self.archive || archive.sha256 != self.artifact.sha256 {
            return Err(PortcoveError::verification("PS1 bootstrap archive changed"));
        }
        self.payload.verify(&staging.join("payload"), operation)
    }

    fn require_closed_context(
        &self,
        library: &Library,
        journal: &LifecycleOperation,
        operation: &OperationCoordinator,
    ) -> Result<()> {
        let staging = journal
            .paths
            .staging
            .as_ref()
            .ok_or_else(|| PortcoveError::state("PS1 bootstrap staging is missing"))?;
        crate::path::refuse_symlink_ancestors(library.root())?;
        crate::path::refuse_symlink_ancestors(staging)?;
        if self.schema_version != 1
            || self.library_root != fs::canonicalize(library.root())?
            || self.library_id != library.identity()?
            || self.port_id != journal.port_id
            || self.final_path != journal.paths.final_path
            || self.activate != journal.activate
            || self.created_at != journal.created_at
            || self.payload.operation_id() != journal.id
            || operation.operation_id() != journal.id
            || self.payload.root() != fs::canonicalize(staging.join("payload"))?
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
            return Err(PortcoveError::state("PS1 bootstrap custody changed"));
        }
        operation.checkpoint()
    }
}
