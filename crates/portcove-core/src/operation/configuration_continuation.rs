//! One closed failed configuration, preserved before a fresh owned build.
//! These values cannot be deserialized or authorize a later preparation stage.
use super::*;

const TABLES: [&str; 5] = [
    "managed_psx_bootstrap",
    "managed_psx_materialized_inputs",
    "managed_psx_normalized_inputs",
    "managed_psx_pending_generation",
    "managed_psx_generation",
];

pub(crate) struct ConfigurationBindings {
    library_id: String,
    receipts: Vec<(&'static str, Option<(String, String)>)>,
    history: Option<GenerationAttemptHistory>,
    started_snapshot: Option<String>,
}

pub(crate) struct UnverifiedConfigurationPredecessor {
    witness: crate::psx::GeneratedInstallWitness,
    closed: ClosedGenerationPredecessor,
    snapshot: String,
    bindings: ConfigurationBindings,
    started: Option<LifecycleOperation>,
}

fn snapshot(journal: &LifecycleOperation) -> Result<String> {
    Ok(serde_json::to_string(
        &generation_continuation::journal_value(journal)?,
    )?)
}

impl ConfigurationBindings {
    pub(super) fn require_completed(&self, journal: &LifecycleOperation) -> Result<()> {
        let mut expected: serde_json::Value =
            serde_json::from_str(self.started_snapshot.as_deref().ok_or_else(|| {
                PortcoveError::state("PS1 configuration acknowledgement has no owned start")
            })?)?;
        expected[14] = serde_json::json!(journal.updated_at);
        expected[16] = serde_json::json!(1);
        if journal.preparation_process_quiesced != Some(true)
            || expected != generation_continuation::journal_value(journal)?
        {
            return Err(PortcoveError::conflict(
                "PS1 configuration completion custody changed",
            ));
        }
        Ok(())
    }

    pub(super) fn require_current(
        &self,
        connection: &rusqlite::Connection,
        operation: &OperationCoordinator,
    ) -> Result<()> {
        operation.checkpoint()?;
        let identity: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM library_identity WHERE singleton=1 AND id=?1)",
            [&self.library_id],
            |row| row.get(0),
        )?;
        if !identity {
            return Err(PortcoveError::conflict("PS1 configuration library changed"));
        }
        GenerationAttemptHistory::require_binding_in(self.history.as_ref(), connection, operation)?;
        for (table, expected) in &self.receipts {
            let current: bool = match expected {
                Some((json, sha)) => connection.query_row(
                    &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE operation_id=?1 AND witness_json=?2 AND witness_sha256=?3)"),
                    params![operation.operation_id(), json, sha], |row| row.get(0),
                )?,
                None => connection.query_row(
                    &format!("SELECT NOT EXISTS(SELECT 1 FROM {table} WHERE operation_id=?1)"),
                    [operation.operation_id()], |row| row.get(0),
                )?,
            };
            if !current {
                return Err(PortcoveError::conflict(
                    "PS1 configuration predecessor changed",
                ));
            }
        }
        let vacant: bool = connection.query_row(
            "SELECT NOT EXISTS(SELECT 1 FROM managed_psx_configuration WHERE operation_id=?1)
              AND NOT EXISTS(SELECT 1 FROM managed_psx_compilation WHERE operation_id=?1)
              AND NOT EXISTS(SELECT 1 FROM managed_psx_compile_history WHERE operation_id=?1)
              AND NOT EXISTS(SELECT 1 FROM installs WHERE id=?1 OR port_id=(SELECT port_id FROM lifecycle_operations WHERE id=?1))",
            [operation.operation_id()], |row| row.get(0),
        )?;
        if !vacant {
            return Err(PortcoveError::conflict(
                "PS1 configuration successor already exists",
            ));
        }
        Ok(())
    }

    fn receipt(&self, journal: &LifecycleOperation) -> Result<serde_json::Value> {
        Ok(serde_json::json!({
            "prior_journal": generation_continuation::journal_value(journal)?,
            "library_id": self.library_id,
            "predecessors": self.receipts.iter().map(|(table, receipt)| (*table, receipt.as_ref().map(|(_, sha)| sha))).collect::<std::collections::BTreeMap<_, _>>(),
            "generation_attempt_history": self.history,
            "purpose": "failed configuration evidence only; no execution or continuation authority"
        }))
    }
}

impl UnverifiedConfigurationPredecessor {
    pub(crate) fn witness(&self) -> &crate::psx::GeneratedInstallWitness {
        &self.witness
    }

    #[cfg(test)]
    pub(crate) fn bindings_for_fixture(&self) -> &ConfigurationBindings {
        &self.bindings
    }

    pub(crate) fn configure(
        self,
        library: &Library,
        preparation: &crate::psx::PsxManagedPreparation,
        operation: &OperationCoordinator,
    ) -> (
        Result<(crate::psx::ConfiguredInstallWitness, ConfigurationBindings)>,
        bool,
    ) {
        let Self {
            witness,
            closed,
            bindings,
            started,
            ..
        } = self;
        let Some(started) = started else {
            return (
                Err(PortcoveError::state("PS1 configuration has no owned start")),
                true,
            );
        };
        let check = || {
            let connection = database::connect(library.root())?;
            bindings.require_current(&connection, operation)?;
            let current: bool = connection.query_row(
                &format!("SELECT EXISTS(SELECT 1 FROM lifecycle_operations l WHERE id=?1 AND {PSX_JOURNAL_SNAPSHOT}=?2)"),
                params![operation.operation_id(), snapshot(&started)?], |row| row.get(0),
            )?;
            if !current {
                return Err(PortcoveError::conflict(
                    "PS1 configuration owned worker changed",
                ));
            }
            Ok(())
        };
        let receipt = match bindings.receipt(closed.journal()) {
            Ok(receipt) => receipt,
            Err(error) => return (Err(error), true),
        };
        let (result, quiesced) =
            witness.configure_recovered(library, &closed, preparation, operation, &receipt, check);
        (result.map(|configured| (configured, bindings)), quiesced)
    }
}

impl OperationStore {
    pub(crate) fn psx_failed_configuration(
        &self,
        operation: &OperationCoordinator,
    ) -> Result<UnverifiedConfigurationPredecessor> {
        let prior = self
            .get(operation.operation_id())?
            .ok_or_else(|| PortcoveError::state("PS1 configuration owner is missing"))?;
        if prior.last_error.is_none() {
            return Err(PortcoveError::conflict(
                "PS1 configuration has no retained failure",
            ));
        }
        let closed = ClosedGenerationPredecessor::new(prior)?;
        crate::psx::require_fresh_configuration_attempt(closed.journal())?;
        let (witness, snapshot) = self.psx_stage_fenced_with(
            PsxStageTable::Generation,
            operation,
            || Ok(()),
            |witness: &crate::psx::GeneratedInstallWitness, journal| {
                closed.require_same(journal)?;
                witness.verify_closed_configuration(&self.library, &closed, operation)
            },
        )?;
        let connection = database::connect(self.library.root())?;
        let generation_receipt = witness.configuration_parent_receipt()?;
        let mut receipts = Vec::with_capacity(TABLES.len());
        for table in TABLES {
            let row: Option<(String, String)> = connection.query_row(
                &format!("SELECT witness_json,witness_sha256 FROM {table} WHERE operation_id=?1 AND length(CAST(witness_json AS BLOB)) BETWEEN 1 AND ?2"),
                params![operation.operation_id(), MAX_PSX_WITNESS_BYTES as i64], |row| Ok((row.get(0)?, row.get(1)?)),
            ).optional()?;
            if row
                .as_ref()
                .is_some_and(|(json, sha)| hex::encode(Sha256::digest(json.as_bytes())) != *sha)
                || (row.is_none() && table != "managed_psx_materialized_inputs")
            {
                return Err(PortcoveError::verification(
                    "PS1 configuration retained receipt is missing or changed",
                ));
            }
            if table == "managed_psx_generation" && row.as_ref() != Some(&generation_receipt) {
                return Err(PortcoveError::conflict(
                    "PS1 configuration generation changed after inspection",
                ));
            }
            if table == "managed_psx_pending_generation" {
                witness.require_configuration_pending(
                    &row.as_ref().expect("required pending receipt").0,
                )?;
            }
            receipts.push((table, row));
        }
        let bindings = ConfigurationBindings {
            library_id: crate::psx::PsxStageWitness::library_id(&witness).to_owned(),
            history: crate::psx::PsxStageWitness::generation_attempt_history(&witness).cloned(),
            started_snapshot: None,
            receipts,
        };
        bindings.require_current(&connection, operation)?;
        Ok(UnverifiedConfigurationPredecessor {
            witness,
            closed,
            snapshot,
            bindings,
            started: None,
        })
    }

    pub(crate) fn start_psx_configuration(
        &self,
        decoded: &mut UnverifiedConfigurationPredecessor,
        operation: &OperationCoordinator,
    ) -> Result<LifecycleOperation> {
        if decoded.started.is_some() {
            return Err(PortcoveError::conflict("PS1 configuration already started"));
        }
        decoded
            .witness
            .verify_closed_configuration(&self.library, &decoded.closed, operation)?;
        crate::psx::require_fresh_configuration_attempt(decoded.closed.journal())?;
        let mut connection = database::connect(self.library.root())?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        decoded.bindings.require_current(&transaction, operation)?;
        let updated_at = Library::now();
        let changed = transaction.execute(
            &format!("UPDATE lifecycle_operations AS l SET preparation_process_quiesced=0,updated_at=?1 WHERE id=?2 AND {PSX_JOURNAL_SNAPSHOT}=?3"),
            params![updated_at, operation.operation_id(), decoded.snapshot],
        )?;
        if changed != 1 {
            return Err(PortcoveError::conflict(
                "PS1 configuration start journal changed",
            ));
        }
        let mut started = decoded.closed.journal().clone();
        started.updated_at = updated_at;
        started.preparation_process_quiesced = Some(false);
        let started_snapshot = snapshot(&started)?;
        operation.checkpoint()?;
        transaction.commit()?;
        decoded.started = Some(started.clone());
        decoded.bindings.started_snapshot = Some(started_snapshot);
        Ok(started)
    }

    pub(crate) fn put_psx_configuration_outcome(
        &self,
        started: &LifecycleOperation,
        completed: &mut LifecycleOperation,
    ) -> Result<()> {
        completed.updated_at = Library::now();
        let mut expected = generation_continuation::journal_value(started)?;
        expected[14] = serde_json::json!(completed.updated_at);
        expected[16] = serde_json::json!(completed.preparation_process_quiesced.map(i64::from));
        if expected != generation_continuation::journal_value(completed)? {
            return Err(PortcoveError::conflict(
                "PS1 configuration outcome changed its retained failure",
            ));
        }
        let mut connection = database::connect(self.library.root())?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = transaction.execute(
            &format!("UPDATE lifecycle_operations AS l SET updated_at=?1,preparation_process_quiesced=?2 WHERE id=?3 AND {PSX_JOURNAL_SNAPSHOT}=?4"),
            params![completed.updated_at, completed.preparation_process_quiesced.map(i64::from), started.id, snapshot(started)?],
        )?;
        if changed != 1 {
            return Err(PortcoveError::conflict(
                "PS1 configuration outcome journal drifted",
            ));
        }
        transaction.commit()?;
        Ok(())
    }
}
