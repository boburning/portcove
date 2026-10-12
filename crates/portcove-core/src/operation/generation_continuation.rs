//! Acknowledgement of positively closed normalized custody, never execution proof.
use super::*;
use serde::{Deserialize, Serialize};

const MAX_ATTEMPTS: usize = 32;
const MAX_RECEIPT_BYTES: usize = 64 * 1024;
const MAX_HISTORY_BYTES: usize = 1024 * 1024;

/// Only the store creates this historical context. It retains the original
/// error, rather than editing a journal to pass an ordinary strict getter.
pub(crate) struct ClosedGenerationPredecessor {
    journal: LifecycleOperation,
}

impl ClosedGenerationPredecessor {
    pub(super) fn new(journal: LifecycleOperation) -> Result<Self> {
        if journal.kind != LifecycleOperationKind::Install
            || journal.phase != LifecyclePhase::StagedPreparing
            || journal.preparation_process_quiesced != Some(true)
            || journal.install.is_some()
            || journal.preparation.is_some()
            || journal.relocation.is_some()
            || journal.source_import.is_some()
            || journal.paths.quarantine.is_some()
            || !journal.original_paths.is_empty()
        {
            return Err(PortcoveError::conflict(
                "PS1 generation predecessor is not positively closed",
            ));
        }
        Ok(Self { journal })
    }

    pub(crate) fn journal(&self) -> &LifecycleOperation {
        &self.journal
    }

    pub(super) fn require_same(&self, journal: &LifecycleOperation) -> Result<()> {
        if journal_value(&self.journal)? != journal_value(journal)? {
            return Err(PortcoveError::conflict(
                "PS1 generation historical journal changed",
            ));
        }
        Ok(())
    }
}

fn journal_value(journal: &LifecycleOperation) -> Result<serde_json::Value> {
    Ok(serde_json::json!([
        journal.id,
        journal.kind.to_string(),
        journal.port_id,
        journal.phase.to_string(),
        path_string(journal.paths.staging.as_ref())?,
        path_string(journal.paths.final_path.as_ref())?,
        path_string(journal.paths.quarantine.as_ref())?,
        journal
            .install
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?,
        journal
            .relocation
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?,
        journal
            .source_import
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?,
        serde_json::to_string(&journal.original_paths)?,
        journal.activate as i64,
        journal.last_error,
        journal.created_at,
        journal.updated_at,
        journal
            .preparation
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?,
        journal.preparation_process_quiesced.map(i64::from)
    ]))
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct GenerationAttemptReceipt {
    schema_version: u32,
    prior_journal: serde_json::Value,
    normalized_sha256: String,
    bootstrap_sha256: String,
    worker_updated_at: i64,
}

/// A digest of the complete bounded ordered history. Decoding this value grants
/// no continuation: every user compares it with the current durable rows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct GenerationAttemptHistory {
    count: usize,
    bytes: usize,
    sha256: String,
}

impl GenerationAttemptHistory {
    pub(crate) fn require_binding_in(
        binding: Option<&Self>,
        connection: &rusqlite::Connection,
        operation: &OperationCoordinator,
    ) -> Result<()> {
        let current = Self::load(connection, operation)?;
        if binding.is_some_and(|expected| *expected != current)
            || (binding.is_none() && current.count != 0)
        {
            return Err(PortcoveError::conflict(
                "PS1 generation attempt history binding changed",
            ));
        }
        Ok(())
    }

    pub(super) fn load(
        connection: &rusqlite::Connection,
        operation: &OperationCoordinator,
    ) -> Result<Self> {
        let history = Self::read(connection, operation)?;
        let anchor: Option<String> = connection.query_row(
            "SELECT generation_attempt_history_sha256 FROM managed_psx_normalized_inputs WHERE operation_id=?1",
            [operation.operation_id()], |row| row.get(0),
        ).optional()?;
        if anchor.as_deref().is_some_and(|sha| sha != history.sha256)
            || (anchor.is_none() && history.count != 0)
        {
            return Err(PortcoveError::verification(
                "PS1 generation attempt history anchor changed",
            ));
        }
        Ok(history)
    }

    fn read(connection: &rusqlite::Connection, operation: &OperationCoordinator) -> Result<Self> {
        let (count, bytes): (i64, i64) = connection.query_row(
            "SELECT count(*),coalesce(sum(length(CAST(receipt_json AS BLOB))),0)
             FROM managed_psx_generation_attempts WHERE operation_id=?1",
            [operation.operation_id()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if !(0..=MAX_ATTEMPTS as i64).contains(&count)
            || !(0..=MAX_HISTORY_BYTES as i64).contains(&bytes)
        {
            return Err(PortcoveError::state(
                "PS1 generation attempt history exceeds its budget",
            ));
        }
        let mut statement = connection.prepare(
            "SELECT attempt,receipt_json,receipt_sha256 FROM managed_psx_generation_attempts
             WHERE operation_id=?1 AND length(CAST(receipt_json AS BLOB)) BETWEEN 1 AND 65536
             ORDER BY attempt LIMIT 33",
        )?;
        let rows = statement.query_map([operation.operation_id()], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        let mut digest = Sha256::new();
        let mut observed_count = 0usize;
        let mut observed_bytes = 0usize;
        for row in rows {
            operation.checkpoint()?;
            let (attempt, json, sha) = row?;
            observed_count += 1;
            observed_bytes = observed_bytes
                .checked_add(json.len())
                .ok_or_else(|| PortcoveError::state("PS1 generation history byte overflow"))?;
            if attempt != observed_count as i64
                || json.is_empty()
                || json.len() > MAX_RECEIPT_BYTES
                || observed_count > MAX_ATTEMPTS
                || observed_bytes > MAX_HISTORY_BYTES
                || hex::encode(Sha256::digest(json.as_bytes())) != sha
            {
                return Err(PortcoveError::verification(
                    "PS1 generation attempt history changed",
                ));
            }
            let receipt: GenerationAttemptReceipt = serde_json::from_str(&json)?;
            if receipt.schema_version != 1
                || receipt.prior_journal.as_array().map(Vec::len) != Some(17)
                || receipt.prior_journal[0] != operation.operation_id()
                || receipt.prior_journal[12].as_str().is_none()
                || receipt.prior_journal[16] != 1
                || receipt.normalized_sha256.len() != 64
                || receipt.bootstrap_sha256.len() != 64
            {
                return Err(PortcoveError::verification(
                    "PS1 generation historical receipt is invalid",
                ));
            }
            digest.update(attempt.to_le_bytes());
            digest.update((json.len() as u64).to_le_bytes());
            digest.update(json.as_bytes());
        }
        if observed_count as i64 != count || observed_bytes as i64 != bytes {
            return Err(PortcoveError::conflict(
                "PS1 generation attempt history drifted",
            ));
        }
        Ok(Self {
            count: observed_count,
            bytes: observed_bytes,
            sha256: hex::encode(digest.finalize()),
        })
    }

    pub(crate) fn require_current(
        &self,
        library: &Library,
        operation: &OperationCoordinator,
    ) -> Result<()> {
        self.require_current_in(&library.connection()?, operation)
    }

    pub(super) fn require_current_in(
        &self,
        connection: &rusqlite::Connection,
        operation: &OperationCoordinator,
    ) -> Result<()> {
        if Self::load(connection, operation)? != *self {
            return Err(PortcoveError::conflict(
                "PS1 generation attempt history no longer matches",
            ));
        }
        Ok(())
    }
}

impl OperationStore {
    /// Retain closure/error truth after joining, including a cancelled activity.
    /// This writes only the owned journal's outcome; drift is never overwritten.
    pub(crate) fn put_psx_generation_outcome(
        &self,
        prior: &LifecycleOperation,
        completed: &mut LifecycleOperation,
        history: &GenerationAttemptHistory,
        operation: &OperationCoordinator,
    ) -> Result<()> {
        let snapshot = journal_value(prior)?;
        let mut expected = snapshot.clone();
        completed.updated_at = Library::now();
        expected[12] = serde_json::json!(completed.last_error);
        expected[14] = serde_json::json!(completed.updated_at);
        expected[16] = serde_json::json!(completed.preparation_process_quiesced.map(i64::from));
        if prior.id != operation.operation_id() || expected != journal_value(completed)? {
            return Err(PortcoveError::conflict(
                "PS1 generation outcome owner changed",
            ));
        }
        let mut connection = database::connect(self.library.root())?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        // Outcome persistence cannot use the cancelled worker's checkpoint.
        let retention = OperationCoordinator::resume(
            operation.operation_id(),
            "retain-generation-outcome",
            None,
        );
        history.require_current_in(&transaction, &retention)?;
        let changed = transaction.execute(
            &format!("UPDATE lifecycle_operations AS l SET last_error=?1,updated_at=?2,preparation_process_quiesced=?3
             WHERE id=?4 AND {PSX_JOURNAL_SNAPSHOT}=?5"),
            params![completed.last_error, completed.updated_at, completed.preparation_process_quiesced.map(i64::from),
                operation.operation_id(), serde_json::to_string(&snapshot)?],
        )?;
        if changed != 1 {
            return Err(PortcoveError::conflict(
                "PS1 generation outcome journal drifted",
            ));
        }
        transaction.commit()?;
        Ok(())
    }

    /// A single fenced start replaces the unfenced generic worker `put` only
    /// for normalized generation. Original failed custody and acknowledgement
    /// commit together; refusal rolls back both. No external process is started.
    pub(crate) fn start_psx_generation(
        &self,
        decoded: &mut UnverifiedGenerationInputs,
        prior: &LifecycleOperation,
        operation: &OperationCoordinator,
    ) -> Result<LifecycleOperation> {
        decoded.predecessor.require_same(prior)?;
        decoded.witness.verify_generation_context(
            &self.library,
            &decoded.predecessor,
            operation,
        )?;
        if decoded.started
            || journal_value(prior)?
                != serde_json::from_str::<serde_json::Value>(&decoded.journal_snapshot)?
        {
            return Err(PortcoveError::conflict(
                "PS1 generation start snapshot changed",
            ));
        }
        let (sha, json) = decoded.witness.loaded_receipt()?;
        let (bootstrap_sha, bootstrap_json) =
            crate::psx::PsxStageWitness::bootstrap_parent(&decoded.witness).ok_or_else(|| {
                PortcoveError::state("PS1 generation bootstrap binding is missing")
            })?;
        let mut connection = database::connect(self.library.root())?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        decoded
            .attempt_history
            .require_current_in(&transaction, operation)?;
        let current: bool = transaction.query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM lifecycle_operations l
             JOIN managed_psx_normalized_inputs n ON n.operation_id=l.id
             WHERE l.id=?1 AND {PSX_JOURNAL_SNAPSHOT}=?2 AND n.witness_sha256=?3 AND n.witness_json=?4
             AND EXISTS(SELECT 1 FROM managed_psx_bootstrap b WHERE b.operation_id=l.id AND b.witness_sha256=?5 AND b.witness_json=?6)
             AND EXISTS(SELECT 1 FROM library_identity WHERE singleton=1 AND id=?7)
             AND NOT EXISTS(SELECT 1 FROM managed_psx_pending_generation WHERE operation_id=l.id)
             AND NOT EXISTS(SELECT 1 FROM managed_psx_generation WHERE operation_id=l.id)
             AND NOT EXISTS(SELECT 1 FROM managed_psx_configuration WHERE operation_id=l.id)
             AND NOT EXISTS(SELECT 1 FROM managed_psx_compilation WHERE operation_id=l.id)
             AND NOT EXISTS(SELECT 1 FROM managed_psx_compile_history WHERE operation_id=l.id)
             AND NOT EXISTS(SELECT 1 FROM installs WHERE id=l.id OR port_id=l.port_id))"),
            params![operation.operation_id(), decoded.journal_snapshot, sha, json, bootstrap_sha, bootstrap_json,
                crate::psx::PsxStageWitness::library_id(&decoded.witness)], |row| row.get(0),
        )?;
        if !current {
            return Err(PortcoveError::conflict(
                "PS1 generation start custody changed",
            ));
        }
        let updated_at = Library::now();
        if prior.last_error.is_some() {
            let receipt = serde_json::to_string(&GenerationAttemptReceipt {
                schema_version: 1,
                prior_journal: serde_json::from_str(&decoded.journal_snapshot)?,
                normalized_sha256: sha.into(),
                bootstrap_sha256: bootstrap_sha.into(),
                worker_updated_at: updated_at,
            })?;
            if decoded.attempt_history.count >= MAX_ATTEMPTS
                || receipt.len() > MAX_RECEIPT_BYTES
                || decoded
                    .attempt_history
                    .bytes
                    .checked_add(receipt.len())
                    .is_none_or(|bytes| bytes > MAX_HISTORY_BYTES)
            {
                return Err(PortcoveError::state(
                    "PS1 generation attempt retention budget exhausted",
                ));
            }
            transaction.execute(
                "INSERT INTO managed_psx_generation_attempts(operation_id,attempt,receipt_json,receipt_sha256) VALUES (?1,?2,?3,?4)",
                params![operation.operation_id(), (decoded.attempt_history.count + 1) as i64, receipt,
                    hex::encode(Sha256::digest(receipt.as_bytes()))],
            )?;
        }
        let history = GenerationAttemptHistory::read(&transaction, operation)?;
        let anchored = transaction.execute(
            "UPDATE managed_psx_normalized_inputs SET generation_attempt_history_sha256=?1
             WHERE operation_id=?2 AND witness_sha256=?3 AND witness_json=?4 AND generation_attempt_history_sha256=?5",
            params![history.sha256, operation.operation_id(), sha, json, decoded.attempt_history.sha256],
        )?;
        if anchored != 1 {
            return Err(PortcoveError::conflict(
                "PS1 generation history acknowledgement anchor drifted",
            ));
        }
        let changed = transaction.execute(
            &format!("UPDATE lifecycle_operations AS l SET last_error=NULL,preparation_process_quiesced=0,updated_at=?1
             WHERE id=?2 AND {PSX_JOURNAL_SNAPSHOT}=?3"),
            params![updated_at, operation.operation_id(), decoded.journal_snapshot],
        )?;
        if changed != 1 {
            return Err(PortcoveError::conflict(
                "PS1 generation acknowledgement refused",
            ));
        }
        history.require_current_in(&transaction, operation)?;
        operation.checkpoint()?;
        transaction.commit()?;
        decoded.attempt_history = history;
        decoded.started = true;
        let mut worker = prior.clone();
        worker.last_error = None;
        worker.preparation_process_quiesced = Some(false);
        worker.updated_at = updated_at;
        Ok(worker)
    }
}
