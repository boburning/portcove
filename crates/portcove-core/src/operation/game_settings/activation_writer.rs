//! Checked writes to an existing managed settings activation record.
use super::*;
use crate::operation::OperationStore;

// Prospective slot 71 follows the saved-variant writer. Leave this unset until
// the migration actually recognizes settings activation custody. An unrelated
// future schema version must not enable this writer.
const SETTINGS_ACTIVATION_WRITER_SCHEMA: Option<i64> = None;

pub(crate) struct SettingsActivationWriter<'a> {
    store: &'a OperationStore,
}

impl OperationStore {
    pub(crate) fn settings_activation_writer(
        &self,
    ) -> Result<Option<SettingsActivationWriter<'_>>> {
        let Some(required) = SETTINGS_ACTIVATION_WRITER_SCHEMA else {
            return Ok(None);
        };
        if crate::database::CURRENT_SCHEMA_VERSION < required {
            return Ok(None);
        }
        let version: i64 = self.library.connection()?.query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |row| row.get(0),
        )?;
        Ok((version == crate::database::CURRENT_SCHEMA_VERSION)
            .then_some(SettingsActivationWriter { store: self }))
    }
}

impl SettingsActivationWriter<'_> {
    #[cfg(test)]
    pub(crate) fn for_windows_fixture(store: &OperationStore) -> SettingsActivationWriter<'_> {
        SettingsActivationWriter { store }
    }

    pub(crate) fn confirm(&self, operation: &LifecycleOperation) -> Result<()> {
        let current = self.store.get(&operation.id)?.ok_or_else(invalid)?;
        if current.created_at != operation.created_at
            || current.port_id != operation.port_id
            || current.phase != operation.phase
            || current.kind != operation.kind
            || encoding(&current)? != encoding(operation)?
        {
            return Err(invalid());
        }
        Ok(())
    }

    pub(crate) fn bind_stage(
        &self,
        operation: &mut LifecycleOperation,
        role: &str,
        identity: String,
    ) -> Result<()> {
        if operation.phase != LifecyclePhase::Preparing {
            return Err(invalid());
        }
        let mut next = operation.clone();
        let payload = next.settings_activation.as_mut().ok_or_else(invalid)?;
        let leg = match role {
            "canonical" => &mut payload.canonical,
            "runtime" => payload.runtime.as_mut().ok_or_else(invalid)?,
            _ => return Err(invalid()),
        };
        if leg.replacement_identity.is_some() {
            return Err(invalid());
        }
        leg.replacement_identity = Some(identity);
        self.replace(operation, next)
    }

    pub(crate) fn advance(
        &self,
        operation: &mut LifecycleOperation,
        phase: LifecyclePhase,
    ) -> Result<()> {
        use LifecyclePhase::*;
        if !matches!(
            (operation.phase, phase),
            (Preparing, Prepared)
                | (Prepared, PayloadPublished)
                | (PayloadPublished, MetadataCommitted)
                | (MetadataCommitted, CleanupPending)
        ) {
            return Err(invalid());
        }
        let mut next = operation.clone();
        next.phase = phase;
        next.last_error = None;
        self.replace(operation, next)
    }

    pub(crate) fn record_hold(
        &self,
        operation: &mut LifecycleOperation,
        message: &str,
    ) -> Result<()> {
        let mut next = operation.clone();
        next.last_error = Some(message.chars().take(2048).collect());
        self.replace(operation, next)
    }

    fn replace(
        &self,
        operation: &mut LifecycleOperation,
        mut next: LifecycleOperation,
    ) -> Result<()> {
        validate_journal(&self.store.library, &next)?;
        let (install, payload) = encoding(operation)?;
        let (_, replacement) = encoding(&next)?;
        next.updated_at = Library::now();
        let changed = self.store.library.connection()?.execute(
            "UPDATE lifecycle_operations SET game_settings_json=?7, phase=?8, updated_at=?9, last_error=?10
             WHERE id=?1 AND port_id=?2 AND created_at=?3 AND phase=?4
               AND kind='activate' AND install_json=?5 AND game_settings_json=?6",
            rusqlite::params![operation.id, operation.port_id, operation.created_at, operation.phase.to_string(),
                install, payload, replacement, next.phase.to_string(), next.updated_at, next.last_error],
        )?;
        if changed != 1 {
            return Err(invalid());
        }
        self.confirm(&next)?;
        *operation = next;
        Ok(())
    }

    pub(crate) fn retire(&self, operation: &LifecycleOperation) -> Result<()> {
        if operation.phase != LifecyclePhase::CleanupPending {
            return Err(invalid());
        }
        let (install, payload) = encoding(operation)?;
        let changed = self.store.library.connection()?.execute(
            "DELETE FROM lifecycle_operations
             WHERE id=?1 AND port_id=?2 AND created_at=?3 AND phase='cleanup_pending'
               AND kind='activate' AND install_json=?4 AND game_settings_json=?5",
            rusqlite::params![
                operation.id,
                operation.port_id,
                operation.created_at,
                install,
                payload
            ],
        )?;
        if changed != 1 {
            return Err(invalid());
        }
        if self.store.get(&operation.id)?.is_some() {
            return Err(invalid());
        }
        Ok(())
    }
}

fn encoding(operation: &LifecycleOperation) -> Result<(String, String)> {
    let install = operation.install.as_ref().ok_or_else(invalid)?;
    let payload = operation.settings_activation.as_ref().ok_or_else(invalid)?;
    let encoded = serde_json::to_string(payload)?;
    if encoded.len() > 16384 {
        return Err(invalid());
    }
    Ok((serde_json::to_string(install)?, encoded))
}
