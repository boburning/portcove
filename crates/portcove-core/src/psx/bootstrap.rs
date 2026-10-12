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
}

impl BootstrapWitness {
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
        };
        // Provisional observations only; the joined owner must verify and
        // atomically seal this value after durable positive worker closure.
        Ok(witness)
    }

    pub(crate) fn port_id(&self) -> &str {
        &self.port_id
    }
}

impl PsxStageWitness for BootstrapWitness {
    fn library_id(&self) -> &str {
        &self.library_id
    }

    fn verify(
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
            || journal.last_error.is_some()
            || journal.preparation_process_quiesced != Some(true)
        {
            return Err(PortcoveError::state("PS1 bootstrap custody changed"));
        }
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
