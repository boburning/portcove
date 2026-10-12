use std::{
    fmt,
    path::PathBuf,
    str::FromStr,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{OptionalExtension, TransactionBehavior, params};
use sha2::{Digest, Sha256};
use uuid::Uuid;

#[cfg(test)]
thread_local! {
    static ALL_READ_COUNT: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

use crate::{
    ActivityRecord, InstallRecord, Library, OperationEvent, OperationEventKind, OperationResult,
    OperationTarget, OutputRelocationPlan, PortcoveError, Result, SourceImportPlan, database,
};

pub const OPERATION_EVENT_SCHEMA_VERSION: u32 = 3;

#[cfg(test)]
pub(crate) fn reset_all_read_count() {
    ALL_READ_COUNT.with(|count| count.set(0));
}

#[cfg(test)]
pub(crate) fn all_read_count() -> usize {
    ALL_READ_COUNT.with(std::cell::Cell::get)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LifecycleOperationKind {
    Install,
    Prepare,
    Adopt,
    Remove,
    Restore,
    DeleteBackup,
    Activate,
    Relocate,
    ImportSource,
}

impl fmt::Display for LifecycleOperationKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Install => "install",
            Self::Prepare => "prepare",
            Self::Adopt => "adopt",
            Self::Remove => "remove",
            Self::Restore => "restore",
            Self::DeleteBackup => "delete_backup",
            Self::Activate => "activate",
            Self::Relocate => "relocate",
            Self::ImportSource => "import_source",
        })
    }
}

impl FromStr for LifecycleOperationKind {
    type Err = PortcoveError;

    fn from_str(value: &str) -> Result<Self> {
        let kind = match value {
            "install" => Some(Self::Install),
            "prepare" => Some(Self::Prepare),
            "adopt" => Some(Self::Adopt),
            "remove" => Some(Self::Remove),
            "restore" => Some(Self::Restore),
            "delete_backup" => Some(Self::DeleteBackup),
            "activate" => Some(Self::Activate),
            "relocate" => Some(Self::Relocate),
            "import_source" => Some(Self::ImportSource),
            _ => None,
        };
        kind.ok_or_else(|| {
            PortcoveError::state(format!("unknown lifecycle operation kind: {value}"))
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LifecyclePhase {
    Preparing,
    /// Private staged PSX intent, persisted before generation starts. Ordinary
    /// publication recovery and install cancellation cannot consume its data.
    StagedPreparing,
    Prepared,
    PayloadPublished,
    MetadataCommitted,
    CleanupPending,
}

impl fmt::Display for LifecyclePhase {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Preparing => "preparing",
            Self::StagedPreparing => "staged_preparing",
            Self::Prepared => "prepared",
            Self::PayloadPublished => "payload_published",
            Self::MetadataCommitted => "metadata_committed",
            Self::CleanupPending => "cleanup_pending",
        })
    }
}

impl FromStr for LifecyclePhase {
    type Err = PortcoveError;

    fn from_str(value: &str) -> Result<Self> {
        match value {
            "preparing" => Ok(Self::Preparing),
            "staged_preparing" => Ok(Self::StagedPreparing),
            "prepared" => Ok(Self::Prepared),
            "payload_published" => Ok(Self::PayloadPublished),
            "metadata_committed" => Ok(Self::MetadataCommitted),
            "cleanup_pending" => Ok(Self::CleanupPending),
            _ => Err(PortcoveError::state(format!(
                "unknown lifecycle operation phase: {value}"
            ))),
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct LifecyclePaths {
    pub staging: Option<PathBuf>,
    pub final_path: Option<PathBuf>,
    pub quarantine: Option<PathBuf>,
}

#[derive(Debug, Clone)]
pub(crate) struct LifecycleOperation {
    pub id: String,
    pub kind: LifecycleOperationKind,
    pub port_id: String,
    pub phase: LifecyclePhase,
    pub paths: LifecyclePaths,
    pub install: Option<InstallRecord>,
    pub relocation: Option<OutputRelocationPlan>,
    pub source_import: Option<SourceImportPlan>,
    pub preparation: Option<crate::PreparationPlan>,
    /// `Some(true)` is durable proof that no setup process from this operation
    /// can still own the private tree. `None` is legacy or non-preparation state.
    pub preparation_process_quiesced: Option<bool>,
    pub original_paths: Vec<PathBuf>,
    pub activate: bool,
    pub last_error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl LifecycleOperation {
    pub fn new(
        id: impl Into<String>,
        kind: LifecycleOperationKind,
        port_id: impl Into<String>,
    ) -> Self {
        let now = Library::now();
        Self {
            id: id.into(),
            kind,
            port_id: port_id.into(),
            phase: LifecyclePhase::Preparing,
            paths: LifecyclePaths {
                staging: None,
                final_path: None,
                quarantine: None,
            },
            install: None,
            relocation: None,
            source_import: None,
            preparation: None,
            preparation_process_quiesced: None,
            original_paths: Vec::new(),
            activate: false,
            last_error: None,
            created_at: now,
            updated_at: now,
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct OperationStore {
    library: Library,
}

const MAX_PSX_WITNESS_BYTES: usize = 64 * 1024 * 1024;

pub(crate) fn psx_empty_history_digest() -> String {
    hex::encode(Sha256::digest(b"Portcove private compile history v1\0"))
}

pub(crate) fn psx_extend_history_digest(
    previous: &str,
    cursor: usize,
    json: &str,
) -> Result<String> {
    let previous = hex::decode(previous)
        .map_err(|_| PortcoveError::verification("PS1 history digest changed"))?;
    if previous.len() != 32 || json.len() > MAX_PSX_WITNESS_BYTES || cursor == 0 || cursor > 10000 {
        return Err(PortcoveError::verification(
            "PS1 history identity exceeds bounds",
        ));
    }
    let mut digest = Sha256::new();
    digest.update(b"Portcove private compile history link v1\0");
    digest.update(previous);
    digest.update((cursor as u64).to_le_bytes());
    digest.update((json.len() as u64).to_le_bytes());
    digest.update(Sha256::digest(json.as_bytes()));
    Ok(hex::encode(digest.finalize()))
}

// Verify one bounded row at a time; retain only a domain-separated ordered digest.
// The caller holds an Immediate transaction when this identity grants mutation.
fn psx_compile_history_digest(
    connection: &rusqlite::Connection,
    operation: &OperationCoordinator,
    expected: usize,
) -> Result<String> {
    if expected > 10000 {
        return Err(PortcoveError::verification(
            "PS1 history cursor exceeds graph bound",
        ));
    }
    let mut statement = connection.prepare("SELECT completed_batches,witness_json,witness_sha256 FROM managed_psx_compile_history WHERE operation_id=?1 AND length(CAST(witness_json AS BLOB)) BETWEEN 1 AND ?2 ORDER BY completed_batches LIMIT 10001")?;
    let mut rows = statement.query(params![
        operation.operation_id(),
        MAX_PSX_WITNESS_BYTES as i64
    ])?;
    let mut digest = psx_empty_history_digest();
    let mut count = 0usize;
    let mut bytes = 0u64;
    while let Some(row) = rows.next()? {
        operation.checkpoint()?;
        count += 1;
        let cursor: i64 = row.get(0)?;
        let json: String = row.get(1)?;
        let sha256: String = row.get(2)?;
        bytes = bytes
            .checked_add(json.len() as u64)
            .ok_or_else(|| PortcoveError::verification("PS1 history byte overflow"))?;
        if count > expected
            || cursor != count as i64
            || bytes > 16 * 1024 * 1024 * 1024
            || hex::encode(Sha256::digest(json.as_bytes())) != sha256
        {
            return Err(PortcoveError::verification(
                "PS1 retained compile history changed",
            ));
        }
        digest = psx_extend_history_digest(&digest, count, &json)?;
    }
    let actual: i64 = connection.query_row(
        "SELECT count(*) FROM managed_psx_compile_history WHERE operation_id=?1",
        [operation.operation_id()],
        |row| row.get(0),
    )?;
    if count != expected || actual != count as i64 {
        return Err(PortcoveError::verification(
            "PS1 retained compile history is incomplete",
        ));
    }
    Ok(digest)
}

#[derive(Clone, Copy)]
enum PsxStageTable {
    Bootstrap,
    NormalizedInputs,
    Generation,
    Configuration,
    Compilation,
}

impl PsxStageTable {
    fn name(self) -> &'static str {
        match self {
            Self::Bootstrap => "managed_psx_bootstrap",
            Self::NormalizedInputs => "managed_psx_normalized_inputs",
            Self::Generation => "managed_psx_generation",
            Self::Configuration => "managed_psx_configuration",
            Self::Compilation => "managed_psx_compilation",
        }
    }
    fn has_parent(self) -> bool {
        !matches!(
            self,
            Self::Bootstrap | Self::NormalizedInputs | Self::Generation
        )
    }
    fn parent_name(self) -> &'static str {
        match self {
            Self::Compilation => "managed_psx_configuration",
            _ => "managed_psx_generation",
        }
    }
}

pub(crate) fn psx_witness_json(witness: &impl serde::Serialize) -> Result<String> {
    let mut writer = WitnessWriter(Vec::new());
    serde_json::to_writer(&mut writer, witness)?;
    String::from_utf8(writer.0)
        .map_err(|_| PortcoveError::state("PS1 witness serialization is not UTF-8"))
}

fn psx_bootstrap_parent(
    witness: &impl crate::psx::PsxStageWitness,
) -> Result<Option<(&str, &str)>> {
    let parent = witness.bootstrap_parent();
    if parent.is_some_and(|(sha, json)| {
        json.len() > MAX_PSX_WITNESS_BYTES || hex::encode(Sha256::digest(json.as_bytes())) != sha
    }) {
        return Err(PortcoveError::verification(
            "PS1 acquired predecessor bytes changed",
        ));
    }
    Ok(parent)
}

fn psx_parent_json(witness: &impl crate::psx::PsxStageWitness) -> Result<Option<(&str, String)>> {
    psx_bound_parent(witness.parent()?)
}

fn psx_bound_parent(parent: Option<(&str, String)>) -> Result<Option<(&str, String)>> {
    parent
        .map(|(sha256, json)| {
            if hex::encode(Sha256::digest(json.as_bytes())) != sha256 {
                return Err(PortcoveError::verification(
                    "PS1 configuration generation binding changed",
                ));
            }
            Ok((sha256, json))
        })
        .transpose()
}

// Stop the serializer before either retained bytes or allocation exceed the cap.
struct WitnessWriter(Vec<u8>);

impl std::io::Write for WitnessWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let wanted = self
            .0
            .len()
            .checked_add(bytes.len())
            .filter(|size| *size <= MAX_PSX_WITNESS_BYTES)
            .ok_or_else(|| {
                std::io::Error::other("PS1 generation witness exceeds its byte limit")
            })?;
        if wanted > self.0.capacity() {
            let capacity = wanted
                .max(self.0.capacity().saturating_mul(2))
                .min(MAX_PSX_WITNESS_BYTES);
            self.0.reserve_exact(capacity - self.0.len());
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

const PSX_JOURNAL_SNAPSHOT: &str = "json_array(l.id,l.kind,l.port_id,l.phase,
    l.staging_path,l.final_path,l.quarantine_path,l.install_json,l.relocation_json,
    l.source_import_json,l.original_paths_json,l.activate,l.last_error,l.created_at,
    l.updated_at,l.preparation_json,l.preparation_process_quiesced)";

impl OperationStore {
    pub fn new(library: Library) -> Self {
        Self { library }
    }

    pub fn put(&self, operation: &mut LifecycleOperation) -> Result<()> {
        operation.updated_at = Library::now();
        for path in operation
            .paths
            .staging
            .iter()
            .chain(operation.paths.final_path.iter())
            .chain(operation.paths.quarantine.iter())
            .chain(operation.original_paths.iter())
        {
            crate::path::unicode(path, "lifecycle")?;
        }
        let install_json = operation
            .install
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let relocation_json = operation
            .relocation
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let source_import_json = operation
            .source_import
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let original_paths_json = serde_json::to_string(&operation.original_paths)?;
        let preparation_json = operation
            .preparation
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        database::connect(self.library.root())?.execute(
            "INSERT INTO lifecycle_operations(
               id, kind, port_id, phase, staging_path, final_path, quarantine_path,
               install_json, relocation_json, source_import_json, original_paths_json, activate, last_error, created_at, updated_at, preparation_json,
               preparation_process_quiesced
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
             ON CONFLICT(id) DO UPDATE SET
               kind=excluded.kind,
               port_id=excluded.port_id,
               phase=excluded.phase,
               staging_path=excluded.staging_path,
               final_path=excluded.final_path,
               quarantine_path=excluded.quarantine_path,
               install_json=excluded.install_json,
                relocation_json=excluded.relocation_json,
                source_import_json=excluded.source_import_json,
               original_paths_json=excluded.original_paths_json,
               preparation_json=excluded.preparation_json,
               preparation_process_quiesced=excluded.preparation_process_quiesced,
               activate=excluded.activate,
               last_error=excluded.last_error,
               updated_at=excluded.updated_at",
            params![
                operation.id,
                operation.kind.to_string(),
                operation.port_id,
                operation.phase.to_string(),
                path_string(operation.paths.staging.as_ref())?,
                path_string(operation.paths.final_path.as_ref())?,
                path_string(operation.paths.quarantine.as_ref())?,
                install_json,
                relocation_json,
                source_import_json,
                original_paths_json,
                operation.activate as i64,
                operation.last_error,
                operation.created_at,
                operation.updated_at,
                preparation_json,
                operation.preparation_process_quiesced.map(i64::from),
            ],
        )?;
        Ok(())
    }

    pub fn remove(&self, id: &str) -> Result<()> {
        database::connect(self.library.root())?
            .execute("DELETE FROM lifecycle_operations WHERE id=?1", [id])?;
        Ok(())
    }

    pub fn all(&self) -> Result<Vec<LifecycleOperation>> {
        #[cfg(test)]
        ALL_READ_COUNT.with(|count| count.set(count.get() + 1));
        self.read(None)
    }

    pub fn get(&self, id: &str) -> Result<Option<LifecycleOperation>> {
        Ok(self.read(Some(id))?.pop())
    }

    pub(crate) fn commit_psx_bootstrap(
        &self,
        journal: &LifecycleOperation,
        witness: &crate::psx::BootstrapWitness,
        operation: &OperationCoordinator,
    ) -> Result<()> {
        self.commit_psx_stage(PsxStageTable::Bootstrap, journal, witness, operation)
    }

    pub(crate) fn psx_bootstrap(
        &self,
        operation: &OperationCoordinator,
    ) -> Result<crate::psx::BootstrapWitness> {
        self.psx_stage_fenced(PsxStageTable::Bootstrap, operation, || Ok(()))
    }

    pub(crate) fn commit_psx_normalized_inputs(
        &self,
        journal: &LifecycleOperation,
        witness: &crate::psx::NormalizedInputWitness,
        operation: &OperationCoordinator,
    ) -> Result<()> {
        self.commit_psx_stage(PsxStageTable::NormalizedInputs, journal, witness, operation)
    }

    pub(crate) fn psx_normalized_inputs(
        &self,
        operation: &OperationCoordinator,
    ) -> Result<crate::psx::NormalizedInputWitness> {
        self.psx_stage_fenced(PsxStageTable::NormalizedInputs, operation, || Ok(()))
    }

    #[cfg(test)]
    pub(crate) fn psx_normalized_inputs_before_fence(
        &self,
        operation: &OperationCoordinator,
        before_fence: impl FnOnce() -> Result<()>,
    ) -> Result<crate::psx::NormalizedInputWitness> {
        self.psx_stage_fenced(PsxStageTable::NormalizedInputs, operation, before_fence)
    }

    #[cfg(test)]
    pub(crate) fn psx_bootstrap_before_fence(
        &self,
        operation: &OperationCoordinator,
        before_fence: impl FnOnce() -> Result<()>,
    ) -> Result<crate::psx::BootstrapWitness> {
        self.psx_stage_fenced(PsxStageTable::Bootstrap, operation, before_fence)
    }

    pub(crate) fn commit_psx_generation(
        &self,
        journal: &LifecycleOperation,
        witness: &crate::psx::GeneratedInstallWitness,
        operation: &OperationCoordinator,
    ) -> Result<()> {
        self.commit_psx_stage(PsxStageTable::Generation, journal, witness, operation)
    }

    pub(crate) fn commit_psx_configuration(
        &self,
        journal: &LifecycleOperation,
        witness: &crate::psx::ConfiguredInstallWitness,
        operation: &OperationCoordinator,
    ) -> Result<()> {
        self.commit_psx_stage(PsxStageTable::Configuration, journal, witness, operation)
    }

    pub(crate) fn commit_psx_compilation(
        &self,
        journal: &LifecycleOperation,
        witness: &crate::psx::CompiledInstall,
        operation: &OperationCoordinator,
    ) -> Result<()> {
        self.commit_psx_stage_with_predecessor(
            PsxStageTable::Compilation,
            journal,
            witness,
            operation,
            witness.predecessor()?,
        )
    }

    /// Consume private finalized custody into the existing Prepared recovery contract.
    pub(crate) fn prepare_psx_publication(
        &self,
        journal: &mut LifecycleOperation,
        finalized: &crate::psx::FinalizedInstall,
        operation: &OperationCoordinator,
    ) -> Result<()> {
        self.prepare_psx_publication_fenced(journal, finalized, operation, || Ok(()))
    }

    #[cfg(test)]
    pub(crate) fn prepare_psx_publication_before_fence(
        &self,
        journal: &mut LifecycleOperation,
        finalized: &crate::psx::FinalizedInstall,
        operation: &OperationCoordinator,
        before_fence: impl FnOnce() -> Result<()>,
    ) -> Result<()> {
        self.prepare_psx_publication_fenced(journal, finalized, operation, before_fence)
    }

    fn prepare_psx_publication_fenced(
        &self,
        journal: &mut LifecycleOperation,
        finalized: &crate::psx::FinalizedInstall,
        operation: &OperationCoordinator,
        before_fence: impl FnOnce() -> Result<()>,
    ) -> Result<()> {
        let install = journal
            .install
            .as_ref()
            .ok_or_else(|| PortcoveError::state("PS1 finalized installation record missing"))?;
        if install.id != journal.id
            || install.port_id != journal.port_id
            || Some(&install.path) != journal.paths.final_path.as_ref()
            || install.staged == journal.activate
        {
            return Err(PortcoveError::verification(
                "PS1 finalized installation identity changed",
            ));
        }
        let mut before = journal.clone();
        before.install = None;
        finalized.verify(&self.library, &before, operation)?;
        let compiled = finalized.compilation();
        let (sha, json, history) = compiled.publication_receipt()?;
        let parent = psx_parent_json(compiled)?
            .ok_or_else(|| PortcoveError::state("PS1 configuration parent missing"))?;
        let ancestor = psx_bound_parent(crate::psx::PsxStageWitness::ancestor(compiled)?)?
            .ok_or_else(|| PortcoveError::state("PS1 generation ancestor missing"))?;
        let bootstrap = psx_bootstrap_parent(compiled)?;
        let install_json = serde_json::to_string(install)?;
        let updated_at = Library::now();
        operation.checkpoint()?;
        before_fence()?;
        let mut connection = database::connect(self.library.root())?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if psx_compile_history_digest(&transaction, operation, compiled.completed_batches() - 1)?
            != history
        {
            return Err(PortcoveError::conflict(
                "PS1 history changed before publication intent",
            ));
        }
        let changed = transaction.execute(
            "UPDATE lifecycle_operations SET phase='prepared',install_json=?1,updated_at=?2
             WHERE id=?3 AND kind='install' AND phase='staged_preparing' AND port_id=?4
               AND staging_path IS ?5 AND final_path IS ?6 AND activate=?7
               AND updated_at=?8 AND created_at=?9 AND preparation_process_quiesced=1
               AND install_json IS NULL AND preparation_json IS NULL AND quarantine_path IS NULL
               AND last_error IS NULL AND relocation_json IS NULL AND source_import_json IS NULL AND original_paths_json='[]'
               AND EXISTS(SELECT 1 FROM library_identity WHERE singleton=1 AND id=?10)
               AND EXISTS(SELECT 1 FROM managed_psx_compilation WHERE operation_id=?3 AND witness_sha256=?11 AND witness_json=?12)
               AND EXISTS(SELECT 1 FROM managed_psx_configuration WHERE operation_id=?3 AND witness_sha256=?13 AND witness_json=?14)
               AND EXISTS(SELECT 1 FROM managed_psx_generation WHERE operation_id=?3 AND witness_sha256=?15 AND witness_json=?16)
               AND (?17 IS NULL OR EXISTS(SELECT 1 FROM managed_psx_bootstrap WHERE operation_id=?3 AND witness_sha256=?17 AND witness_json=?18))",
            params![install_json,updated_at,journal.id,journal.port_id,path_string(journal.paths.staging.as_ref())?,path_string(journal.paths.final_path.as_ref())?,journal.activate as i64,journal.updated_at,journal.created_at,crate::psx::PsxStageWitness::library_id(compiled),sha,json,parent.0,parent.1,ancestor.0,ancestor.1,bootstrap.map(|(sha, _)| sha),bootstrap.map(|(_, json)| json)],
        )?;
        if changed != 1 {
            return Err(PortcoveError::conflict(
                "PS1 custody changed before publication intent",
            ));
        }
        operation.checkpoint()?;
        transaction.commit()?;
        journal.phase = LifecyclePhase::Prepared;
        journal.updated_at = updated_at;
        Ok(())
    }

    fn commit_psx_stage(
        &self,
        table: PsxStageTable,
        journal: &LifecycleOperation,
        witness: &impl crate::psx::PsxStageWitness,
        operation: &OperationCoordinator,
    ) -> Result<()> {
        self.commit_psx_stage_with_predecessor(table, journal, witness, operation, None)
    }

    fn commit_psx_stage_with_predecessor(
        &self,
        table: PsxStageTable,
        journal: &LifecycleOperation,
        witness: &impl crate::psx::PsxStageWitness,
        operation: &OperationCoordinator,
        predecessor: Option<(&str, &str, usize, &str)>,
    ) -> Result<()> {
        if let Some((sha, json, _, _)) = predecessor {
            if !matches!(table, PsxStageTable::Compilation)
                || predecessor.is_some_and(|(_, _, cursor, _)| cursor == 0 || cursor > 10000)
                || json.len() > MAX_PSX_WITNESS_BYTES
                || hex::encode(Sha256::digest(json.as_bytes())) != sha
            {
                return Err(PortcoveError::verification(
                    "PS1 compile predecessor bytes changed",
                ));
            }
        }
        witness.verify(&self.library, journal, operation)?;
        let json = psx_witness_json(witness)?;
        let parent = psx_parent_json(witness)?;
        let bootstrap = psx_bootstrap_parent(witness)?;
        let ancestor = psx_bound_parent(witness.ancestor()?)?;
        if table.has_parent() != parent.is_some() {
            return Err(PortcoveError::state("PS1 stage parent identity is missing"));
        }
        let sha256 = hex::encode(Sha256::digest(json.as_bytes()));
        operation.checkpoint()?;
        let mut connection = database::connect(self.library.root())?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let successor_sql = if predecessor.is_some() {
            " AND EXISTS(SELECT 1 FROM managed_psx_compilation WHERE operation_id=?2 AND witness_sha256=?15 AND witness_json=?16)
              ON CONFLICT(operation_id) DO UPDATE SET witness_json=excluded.witness_json,witness_sha256=excluded.witness_sha256
              WHERE witness_sha256=?15 AND witness_json=?16"
        } else {
            " AND ?15 IS NULL AND ?16 IS NULL"
        };
        let input_vacancy_sql = if matches!(table, PsxStageTable::NormalizedInputs) {
            " AND NOT EXISTS(SELECT 1 FROM managed_psx_generation WHERE operation_id=?2)
              AND NOT EXISTS(SELECT 1 FROM managed_psx_configuration WHERE operation_id=?2)
              AND NOT EXISTS(SELECT 1 FROM managed_psx_compilation WHERE operation_id=?2)"
        } else {
            ""
        };
        if let Some((_, _, cursor, history_sha256)) = predecessor {
            if psx_compile_history_digest(&transaction, operation, cursor - 1)? != history_sha256 {
                return Err(PortcoveError::conflict(
                    "PS1 compile history changed before advancement",
                ));
            }
        }
        // The join owner has already durably recorded positive closure. Bind
        // that exact private journal while installing the witness atomically.
        let changed = transaction.execute(
            &format!("INSERT INTO {}(operation_id,witness_json,witness_sha256)
             SELECT id,?1,?8 FROM lifecycle_operations
             WHERE id=?2 AND kind='install' AND phase='staged_preparing' AND port_id=?3
               AND staging_path IS ?4 AND final_path IS ?5 AND activate=?6
               AND updated_at=?7 AND preparation_process_quiesced=1
               AND created_at=?9 AND EXISTS(SELECT 1 FROM library_identity WHERE singleton=1 AND id=?10)
               AND install_json IS NULL AND preparation_json IS NULL
               AND quarantine_path IS NULL AND last_error IS NULL
               AND relocation_json IS NULL AND source_import_json IS NULL
               AND original_paths_json='[]'
               AND (?11 IS NULL OR EXISTS(SELECT 1 FROM {}
                   WHERE operation_id=?2 AND witness_sha256=?11 AND witness_json=?12))
               AND (?13 IS NULL OR EXISTS(SELECT 1 FROM managed_psx_generation
                   WHERE operation_id=?2 AND witness_sha256=?13 AND witness_json=?14))
               AND (?17 IS NULL OR EXISTS(SELECT 1 FROM managed_psx_bootstrap WHERE operation_id=?2 AND witness_sha256=?17 AND witness_json=?18)){input_vacancy_sql}{successor_sql}", table.name(), table.parent_name()),
            params![
                json,
                journal.id,
                journal.port_id,
                path_string(journal.paths.staging.as_ref())?,
                path_string(journal.paths.final_path.as_ref())?,
                journal.activate as i64,
                journal.updated_at,
                sha256,
                journal.created_at,
                witness.library_id(),
                parent.as_ref().map(|(sha, _)| *sha),
                parent.as_ref().map(|(_, json)| json.as_str()),
                ancestor.as_ref().map(|(sha, _)| *sha),
                ancestor.as_ref().map(|(_, json)| json.as_str()),
                predecessor.map(|(sha, _, _, _)| sha),
                predecessor.map(|(_, json, _, _)| json),
                bootstrap.map(|(sha, _)| sha),
                bootstrap.map(|(_, json)| json)
            ],
        )?;
        if changed != 1 {
            return Err(PortcoveError::conflict(
                "PS1 generation journal changed before commit",
            ));
        }
        if let Some((sha, json, cursor, _)) = predecessor {
            let retained = transaction.execute(
                "INSERT INTO managed_psx_compile_history(operation_id,completed_batches,witness_json,witness_sha256)
                 SELECT ?1,?2,?3,?4 WHERE
                 (SELECT coalesce(sum(length(CAST(witness_json AS BLOB))),0) FROM managed_psx_compile_history WHERE operation_id=?1)
                   + length(CAST(?3 AS BLOB)) + ?5 <= 17179869184",
                params![journal.id, cursor as i64, json, sha, psx_witness_json(witness)?.len() as i64],
            )?;
            if retained != 1 {
                return Err(PortcoveError::state(
                    "PS1 compile history exceeds retained evidence budget",
                ));
            }
        }
        if let Some(cursor) = witness.retained_compile_batches() {
            if Some(psx_compile_history_digest(&transaction, operation, cursor - 1)?.as_str())
                != witness.compile_history_identity()
            {
                return Err(PortcoveError::verification(
                    "PS1 committed history differs from sealed checkpoint",
                ));
            }
        }
        operation.checkpoint()?;
        transaction.commit()?;
        Ok(())
    }

    pub(crate) fn require_psx_generation_vacant(
        &self,
        operation: &OperationCoordinator,
    ) -> Result<()> {
        let advanced: bool = database::connect(self.library.root())?.query_row(
            "SELECT EXISTS(SELECT 1 FROM managed_psx_generation WHERE operation_id=?1)
                OR EXISTS(SELECT 1 FROM managed_psx_configuration WHERE operation_id=?1)
                OR EXISTS(SELECT 1 FROM managed_psx_compilation WHERE operation_id=?1)",
            [operation.operation_id()],
            |row| row.get(0),
        )?;
        if advanced {
            return Err(PortcoveError::conflict(
                "PS1 acquired generation already advanced",
            ));
        }
        operation.checkpoint()
    }

    pub(crate) fn require_psx_normalization_vacant(
        &self,
        operation: &OperationCoordinator,
    ) -> Result<()> {
        self.require_psx_generation_vacant(operation)?;
        let retained: bool = database::connect(self.library.root())?.query_row(
            "SELECT EXISTS(SELECT 1 FROM managed_psx_normalized_inputs WHERE operation_id=?1)",
            [operation.operation_id()],
            |row| row.get(0),
        )?;
        if retained {
            return Err(PortcoveError::conflict(
                "PS1 normalized inputs already retained",
            ));
        }
        operation.checkpoint()
    }

    pub(crate) fn psx_generation(
        &self,
        operation: &OperationCoordinator,
    ) -> Result<crate::psx::GeneratedInstallWitness> {
        self.psx_stage_fenced(PsxStageTable::Generation, operation, || Ok(()))
    }

    pub(crate) fn psx_configuration(
        &self,
        operation: &OperationCoordinator,
    ) -> Result<crate::psx::ConfiguredInstallWitness> {
        self.psx_stage_fenced(PsxStageTable::Configuration, operation, || Ok(()))
    }

    pub(crate) fn psx_compilation(
        &self,
        operation: &OperationCoordinator,
    ) -> Result<crate::psx::CompiledInstall> {
        self.psx_stage_fenced(PsxStageTable::Compilation, operation, || Ok(()))
    }

    pub(crate) fn has_psx_compilation(&self, operation: &OperationCoordinator) -> Result<bool> {
        database::connect(self.library.root())?
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM managed_psx_compilation WHERE operation_id=?1)",
                [operation.operation_id()],
                |row| row.get(0),
            )
            .map_err(Into::into)
    }

    #[cfg(test)]
    pub(crate) fn psx_compilation_before_fence(
        &self,
        operation: &OperationCoordinator,
        before_fence: impl FnOnce() -> Result<()>,
    ) -> Result<crate::psx::CompiledInstall> {
        self.psx_stage_fenced(PsxStageTable::Compilation, operation, before_fence)
    }

    #[cfg(test)]
    pub(crate) fn psx_configuration_before_fence(
        &self,
        operation: &OperationCoordinator,
        before_fence: impl FnOnce() -> Result<()>,
    ) -> Result<crate::psx::ConfiguredInstallWitness> {
        self.psx_stage_fenced(PsxStageTable::Configuration, operation, before_fence)
    }

    // Deterministic tests inject journal drift at the verification/fence boundary.
    #[cfg(test)]
    pub(crate) fn psx_generation_before_fence(
        &self,
        operation: &OperationCoordinator,
        before_fence: impl FnOnce() -> Result<()>,
    ) -> Result<crate::psx::GeneratedInstallWitness> {
        self.psx_stage_fenced(PsxStageTable::Generation, operation, before_fence)
    }

    fn psx_stage_fenced<T: crate::psx::PsxStageWitness>(
        &self,
        table: PsxStageTable,
        operation: &OperationCoordinator,
        before_fence: impl FnOnce() -> Result<()>,
    ) -> Result<T> {
        operation.checkpoint()?;
        let mut connection = database::connect(self.library.root())?;
        let parent_selection = if table.has_parent() {
            "p.witness_json,p.witness_sha256"
        } else {
            "NULL,NULL"
        };
        let retained: Option<(String, String, String, Option<String>, Option<String>)> = connection
            .query_row(
                &format!(
                    "SELECT g.witness_json,g.witness_sha256,{PSX_JOURNAL_SNAPSHOT},{parent_selection}
                 FROM {} g JOIN lifecycle_operations l ON l.id=g.operation_id
                 LEFT JOIN {} p ON p.operation_id=g.operation_id
                 WHERE g.operation_id=?1 AND length(CAST(g.witness_json AS BLOB)) BETWEEN 1 AND ?2
                   AND (?3=0 OR length(CAST(p.witness_json AS BLOB)) BETWEEN 1 AND ?2)", table.name(), table.parent_name()
                ),
                params![operation.operation_id(), MAX_PSX_WITNESS_BYTES as i64, table.has_parent() as i64],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .optional()?;
        let (json, sha256, journal_snapshot, parent_json, parent_sha256) =
            retained.ok_or_else(|| {
                PortcoveError::state("PS1 generation witness is missing or oversized")
            })?;
        if hex::encode(Sha256::digest(json.as_bytes())) != sha256 {
            return Err(PortcoveError::verification(
                "PS1 generation witness bytes changed",
            ));
        }
        let mut witness: T = serde_json::from_str(&json)?;
        let bound_parent = psx_parent_json(&witness)?;
        let bootstrap = psx_bootstrap_parent(&witness)?;
        let ancestor = psx_bound_parent(witness.ancestor()?)?;
        if table.has_parent() != bound_parent.is_some()
            || bound_parent.as_ref().map(|(sha, _)| *sha) != parent_sha256.as_deref()
            || bound_parent.as_ref().map(|(_, json)| json.as_str()) != parent_json.as_deref()
        {
            return Err(PortcoveError::verification(
                "PS1 stage retained parent changed",
            ));
        }
        let history = witness
            .retained_compile_batches()
            .map(|count| {
                let previous = count
                    .checked_sub(1)
                    .ok_or_else(|| PortcoveError::verification("PS1 compile cursor is zero"))?;
                psx_compile_history_digest(&connection, operation, previous)
            })
            .transpose()?;
        if history.as_deref() != witness.compile_history_identity() {
            return Err(PortcoveError::verification(
                "PS1 history differs from sealed checkpoint",
            ));
        }
        let journal = self
            .get(operation.operation_id())?
            .ok_or_else(|| PortcoveError::state("PS1 generation lifecycle owner is missing"))?;
        witness.verify(&self.library, &journal, operation)?;
        before_fence()?;
        operation.checkpoint()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(expected) = &history {
            let count = witness.retained_compile_batches().expect("history cursor");
            if psx_compile_history_digest(&transaction, operation, count - 1)? != *expected {
                return Err(PortcoveError::conflict(
                    "PS1 compile history changed during verification",
                ));
            }
        }
        // One SQLite statement observes both exact witness bytes and all durable
        // journal fields together, after the potentially lengthy filesystem checks.
        let unchanged: bool = transaction.query_row(
            &format!(
                "SELECT EXISTS(SELECT 1 FROM {} g
                JOIN lifecycle_operations l ON l.id=g.operation_id
                LEFT JOIN {} p ON p.operation_id=g.operation_id
                WHERE g.operation_id=?1 AND g.witness_json=?2 AND g.witness_sha256=?3
                AND {PSX_JOURNAL_SNAPSHOT}=?4
                AND EXISTS(SELECT 1 FROM library_identity WHERE singleton=1 AND id=?5)
                AND (?6 IS NULL OR (p.witness_json=?6 AND p.witness_sha256=?7))
                AND (?8 IS NULL OR EXISTS(SELECT 1 FROM managed_psx_generation a
                    WHERE a.operation_id=g.operation_id AND a.witness_sha256=?8 AND a.witness_json=?9))
                AND (?11 IS NULL OR EXISTS(SELECT 1 FROM managed_psx_bootstrap b
                    WHERE b.operation_id=g.operation_id AND b.witness_sha256=?11 AND b.witness_json=?12))
                AND (?10 IS NULL OR (
                    (SELECT count(*) FROM managed_psx_compile_history WHERE operation_id=g.operation_id)=?10-1
                    AND NOT EXISTS(SELECT 1 FROM managed_psx_compile_history WHERE operation_id=g.operation_id AND completed_batches>=?10))))",
                table.name(),
                table.parent_name()
            ),
            params![
                operation.operation_id(),
                json,
                sha256,
                journal_snapshot,
                witness.library_id(),
                parent_json,
                parent_sha256,
                ancestor.as_ref().map(|(sha, _)| *sha),
                ancestor.as_ref().map(|(_, json)| json.as_str()),
                witness.retained_compile_batches().map(|count| count as i64),
                bootstrap.map(|(sha, _)| sha),
                bootstrap.map(|(_, json)| json)
            ],
            |row| row.get(0),
        )?;
        if !unchanged {
            return Err(PortcoveError::conflict(
                "PS1 generation custody changed during verification",
            ));
        }
        transaction.commit()?;
        witness.record_load(sha256);
        witness.record_load_json(json);
        if let Some(history) = history {
            witness.record_compile_history(history);
        }
        Ok(witness)
    }

    fn read(&self, id: Option<&str>) -> Result<Vec<LifecycleOperation>> {
        let connection = database::connect(self.library.root())?;
        let where_or_order = if id.is_some() {
            "WHERE id=?1"
        } else {
            "ORDER BY created_at, rowid"
        };
        let mut statement = connection.prepare(&format!(
            "SELECT id, kind, port_id, phase, staging_path, final_path, quarantine_path,
                    install_json, relocation_json, source_import_json, original_paths_json, activate, last_error, created_at, updated_at, preparation_json,
                    preparation_process_quiesced
             FROM lifecycle_operations
             {where_or_order}"
        ))?;
        let rows = statement.query_map(rusqlite::params_from_iter(id), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, Option<String>>(8)?,
                row.get::<_, Option<String>>(9)?,
                row.get::<_, String>(10)?,
                row.get::<_, i64>(11)?,
                row.get::<_, Option<String>>(12)?,
                row.get::<_, i64>(13)?,
                row.get::<_, i64>(14)?,
                row.get::<_, Option<String>>(15)?,
                row.get::<_, Option<i64>>(16)?,
            ))
        })?;
        rows.map(|row| {
            let (
                id,
                kind,
                port_id,
                phase,
                staging_path,
                final_path,
                quarantine_path,
                install_json,
                relocation_json,
                source_import_json,
                original_paths_json,
                activate,
                last_error,
                created_at,
                updated_at,
                preparation_json,
                preparation_process_quiesced,
            ) = row?;
            Ok(LifecycleOperation {
                id,
                kind: kind.parse()?,
                port_id,
                phase: phase.parse()?,
                paths: LifecyclePaths {
                    staging: staging_path.map(PathBuf::from),
                    final_path: final_path.map(PathBuf::from),
                    quarantine: quarantine_path.map(PathBuf::from),
                },
                install: install_json
                    .map(|value| serde_json::from_str(&value))
                    .transpose()?,
                relocation: relocation_json
                    .map(|value| serde_json::from_str(&value))
                    .transpose()?,
                source_import: source_import_json
                    .map(|value| serde_json::from_str(&value))
                    .transpose()?,
                original_paths: serde_json::from_str(&original_paths_json)?,
                preparation: preparation_json
                    .map(|value| serde_json::from_str(&value))
                    .transpose()?,
                preparation_process_quiesced: preparation_process_quiesced.map(|value| value != 0),
                activate: activate != 0,
                last_error,
                created_at,
                updated_at,
            })
        })
        .collect()
    }
}

fn path_string(path: Option<&PathBuf>) -> Result<Option<String>> {
    path.map(|path| crate::path::unicode(path, "lifecycle"))
        .transpose()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LifecycleFaultPoint {
    #[cfg(test)]
    RecoveryInventoried,
    PreparationJournaled,
    PreparationCopied,
    PreparationToolCompleted,
    PreparationOutputsValidated,
    PreparationPrepared,
    PreparationPublished,
    PreparationRegistered,
    SourcePrepared,
    LaunchReadyToSpawn,
    LaunchChildStarted,
    LaunchCollecting,
    InstallPrepared,
    InstallReadyToPublish,
    InstallPrivateCleanup,
    InstallPrivateCleanupJournalRemoval,
    InstallPublished,
    InstallMetadataCommitted,
    AdoptionCopied,
    AdoptionPrivateCleanup,
    AdoptionPrepared,
    AdoptionPublished,
    AdoptionMetadataCommitted,
    RemovalQuarantined,
    RemovalMetadataCommitted,
    RemovalCleanup,
    RestorePrepared,
    RestorePublished,
    RestoreVersionSynchronized,
    BackupStagingCreated,
    BackupDataCopied,
    BackupManifestSynced,
    BackupStagingKept,
    BackupPublished,
    DeleteBackupPrepared,
    DeleteBackupQuarantined,
    DeleteBackupDeleting,
    DeleteBackupDeleted,
    DeleteBackupMetadataCommitted,
    ActivationMetadataCommitted,
    RelocationJournaled,
    RelocationCopyStarted,
    RelocationCopied,
    RelocationPrepared,
    RelocationPublicationPrepared,
    RelocationPublished,
    RelocationMetadataCommitted,
    RelocationCleanupCompleted,
    SourceImportJournaled,
    SourceImportCopyStarted,
    SourceImportCopied,
    SourceImportVerified,
    SourceImportPublicationPrepared,
    SourceImportBeforePublicationRecorded,
    SourceImportBeforePublicationOwnershipRecorded,
    SourceImportPublished,
    SourceImportRegistered,
    SourceImportOriginalQuarantined,
    SourceImportDeleteAttempt,
    SourceImportCleanupCompleted,
}

pub(crate) trait LifecycleFaultInjector: Send + Sync {
    fn check(&self, point: LifecycleFaultPoint) -> Result<()>;
}

#[derive(Debug, Default)]
pub(crate) struct NoLifecycleFaults;

impl LifecycleFaultInjector for NoLifecycleFaults {
    fn check(&self, _point: LifecycleFaultPoint) -> Result<()> {
        Ok(())
    }
}

/// Core-owned identity and ordering for one durable or transient operation.
///
/// Clones share one sequence. Child operations receive their own identity and
/// sequence while retaining the parent's ID for correlation.
#[derive(Debug, Clone)]
pub struct OperationCoordinator {
    operation_id: String,
    parent_operation_id: Option<String>,
    operation: String,
    target: Option<OperationTarget>,
    next_sequence: Arc<AtomicU64>,
    cancellation: Option<Arc<crate::cancellation::CancellationScope>>,
}

impl OperationCoordinator {
    pub fn new(operation: impl Into<String>, target: Option<OperationTarget>) -> Self {
        Self {
            operation_id: Uuid::new_v4().to_string(),
            parent_operation_id: None,
            operation: operation.into(),
            target,
            next_sequence: Arc::new(AtomicU64::new(0)),
            cancellation: None,
        }
    }

    pub fn from_activity(activity: &ActivityRecord) -> Self {
        Self {
            operation_id: activity.id.clone(),
            parent_operation_id: None,
            operation: activity.operation.to_string(),
            target: activity.target_id.as_ref().map(|id| OperationTarget {
                kind: activity.target_kind,
                id: id.clone(),
            }),
            next_sequence: Arc::new(AtomicU64::new(0)),
            cancellation: None,
        }
    }

    pub(crate) fn resume(
        operation_id: impl Into<String>,
        operation: impl Into<String>,
        target: Option<OperationTarget>,
    ) -> Self {
        Self {
            operation_id: operation_id.into(),
            parent_operation_id: None,
            operation: operation.into(),
            target,
            next_sequence: Arc::new(AtomicU64::new(0)),
            cancellation: None,
        }
    }

    pub fn child(&self, operation: impl Into<String>, target: Option<OperationTarget>) -> Self {
        Self {
            operation_id: Uuid::new_v4().to_string(),
            parent_operation_id: Some(self.operation_id.clone()),
            operation: operation.into(),
            target,
            next_sequence: Arc::new(AtomicU64::new(0)),
            cancellation: self.cancellation.clone(),
        }
    }

    /// A caller must first load the retained lifecycle owner. Its worker keeps
    /// that durable ID while cancellation and event ancestry belong to this
    /// fresh activity, rather than an already finished historical activity.
    #[cfg(feature = "qualification-fixtures")]
    pub(crate) fn retained_child(&self, operation_id: &str, operation: impl Into<String>) -> Self {
        Self {
            operation_id: operation_id.to_owned(),
            parent_operation_id: Some(self.operation_id.clone()),
            operation: operation.into(),
            target: self.target.clone(),
            next_sequence: Arc::new(AtomicU64::new(0)),
            cancellation: self.cancellation.clone(),
        }
    }

    pub(crate) fn cancellable(
        library: &Library,
        activity: &ActivityRecord,
        owner: &str,
    ) -> Result<Self> {
        let mut operation = Self::from_activity(activity);
        operation.cancellation = Some(Arc::new(crate::cancellation::CancellationScope::begin(
            library, activity, owner,
        )?));
        Ok(operation)
    }

    pub(crate) fn checkpoint(&self) -> Result<()> {
        self.cancellation
            .as_ref()
            .map_or(Ok(()), |scope| scope.checkpoint())
    }

    pub(crate) fn begin_publication(&self) -> Result<()> {
        self.cancellation
            .as_ref()
            .map_or(Ok(()), |scope| scope.begin_publication())
    }

    pub(crate) async fn interruptible<T>(
        &self,
        future: impl std::future::Future<Output = Result<T>>,
    ) -> Result<T> {
        match &self.cancellation {
            Some(scope) => scope.interruptible(future).await,
            None => future.await,
        }
    }

    pub fn operation_id(&self) -> &str {
        &self.operation_id
    }

    pub fn started(&self) -> OperationEvent {
        self.event(OperationEventKind::Started)
    }

    pub fn source_candidate(&self, candidate: &crate::SourceRecord) -> OperationEvent {
        self.event(OperationEventKind::SourceCandidate {
            profile_id: candidate.profile_id.clone(),
            path: candidate.path.clone(),
            sha256: candidate.sha256.clone(),
            size: candidate.size,
        })
    }

    pub fn progress(
        &self,
        phase: impl Into<String>,
        completed: u64,
        total: Option<u64>,
    ) -> OperationEvent {
        self.event(OperationEventKind::Progress {
            phase: phase.into(),
            completed,
            total,
        })
    }

    pub fn message(&self, level: impl Into<String>, message: impl Into<String>) -> OperationEvent {
        self.event(OperationEventKind::Message {
            level: level.into(),
            message: message.into(),
        })
    }

    pub fn finished(&self, result: OperationResult) -> OperationEvent {
        self.event(OperationEventKind::Finished { result })
    }

    fn event(&self, event: OperationEventKind) -> OperationEvent {
        OperationEvent {
            schema_version: OPERATION_EVENT_SCHEMA_VERSION,
            operation_id: self.operation_id.clone(),
            parent_operation_id: self.parent_operation_id.clone(),
            sequence: self.next_sequence.fetch_add(1, Ordering::Relaxed),
            timestamp_ms: now_millis(),
            operation: self.operation.clone(),
            target: self.target.clone(),
            event,
        }
    }
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use crate::{ActivityOperation, ActivityStatus, ActivityTargetKind};

    use super::*;

    fn activity() -> ActivityRecord {
        ActivityRecord {
            id: "durable-activity".into(),
            operation: ActivityOperation::Install,
            target_kind: ActivityTargetKind::Port,
            target_id: Some("lighthouse".into()),
            status: ActivityStatus::Running,
            message: None,
            failure: None,
            started_at: 1,
            finished_at: None,
            cancellation: None,
        }
    }

    #[test]
    fn durable_activity_identity_and_sequence_are_reused() {
        let operation = OperationCoordinator::from_activity(&activity());

        let started = operation.started();
        let progress = operation.progress("download", 4, Some(8));
        let finished = operation.finished(OperationResult::Succeeded);

        assert_eq!(started.operation_id, "durable-activity");
        assert_eq!(started.target.unwrap().id, "lighthouse");
        assert_eq!(started.sequence, 0);
        assert_eq!(progress.sequence, 1);
        assert_eq!(finished.sequence, 2);
    }

    #[test]
    fn overlapping_and_nested_operations_remain_independently_ordered() {
        let first = OperationCoordinator::new("first", None);
        let second = OperationCoordinator::new("second", None);
        let child = first.child("nested", None);

        let events = [
            second.started(),
            child.started(),
            first.started(),
            second.finished(OperationResult::Failed),
            child.finished(OperationResult::Succeeded),
            first.finished(OperationResult::Succeeded),
        ];

        assert_ne!(first.operation_id(), second.operation_id());
        assert_eq!(
            events[1].parent_operation_id.as_deref(),
            Some(first.operation_id())
        );
        assert_eq!(events[0].sequence, 0);
        assert_eq!(events[3].sequence, 1);
        assert_eq!(events[1].sequence, 0);
        assert_eq!(events[4].sequence, 1);
        assert_eq!(events[2].sequence, 0);
        assert_eq!(events[5].sequence, 1);
    }
}
