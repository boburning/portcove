use std::path::{Component, Path, PathBuf};

use crate::{
    Library, PortcoveError, Result,
    operation::{LifecycleOperation, LifecycleOperationKind, LifecyclePhase, OperationStore},
    path::refuse_symlink_ancestors,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RemovalPhase {
    Quarantining,
    Quarantined,
    Committed,
    CleanupPending,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removal_family_decodes_all_released_phases_without_writes() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let store = OperationStore::new(library.clone());
        let mut operation = LifecycleOperation::new(
            "legacy-removal",
            LifecycleOperationKind::Remove,
            "fixture-port",
        );
        operation.paths.quarantine = Some(library.recovery_dir().join(&operation.id));
        for (stored, expected) in [
            (LifecyclePhase::Preparing, RemovalPhase::Quarantining),
            (LifecyclePhase::PayloadPublished, RemovalPhase::Quarantined),
            (LifecyclePhase::MetadataCommitted, RemovalPhase::Committed),
            (LifecyclePhase::CleanupPending, RemovalPhase::CleanupPending),
        ] {
            operation.phase = stored;
            store.put(&mut operation).unwrap();
            let persisted = store.get(&operation.id).unwrap().unwrap();
            assert_eq!(
                RemovalOperation::decode(&library, &persisted)
                    .unwrap()
                    .phase,
                expected
            );
            assert_eq!(
                store.get(&operation.id).unwrap().unwrap().updated_at,
                persisted.updated_at
            );
            assert!(!library.recovery_dir().join(&operation.id).exists());
        }
    }

    #[test]
    fn removal_family_transitions_reject_skipped_and_changed_intent() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let store = OperationStore::new(library.clone());
        let mut operation = LifecycleOperation::new(
            "checked-removal",
            LifecycleOperationKind::Remove,
            "fixture-port",
        );
        operation.paths.quarantine = Some(library.recovery_dir().join(&operation.id));
        store.put(&mut operation).unwrap();
        let mut removal = RemovalOperation::decode(&library, &operation).unwrap();
        assert!(
            removal
                .advance(RemovalPhase::Committed, &mut operation, &store)
                .is_err()
        );
        for case in 0..6 {
            let mut changed = operation.clone();
            match case {
                0 => changed.port_id = "other-port".to_owned(),
                1 => changed.paths.quarantine = Some(temporary.path().join("other")),
                2 => changed.original_paths.push(temporary.path().join("other")),
                3 => changed.phase = LifecyclePhase::PayloadPublished,
                4 => changed.activate = true,
                5 => changed.created_at += 1,
                _ => unreachable!(),
            }
            assert!(
                removal
                    .advance(RemovalPhase::Quarantined, &mut changed, &store)
                    .is_err()
            );
            assert_eq!(
                store.get(&operation.id).unwrap().unwrap().phase,
                LifecyclePhase::Preparing
            );
        }
        for next in [
            RemovalPhase::Quarantined,
            RemovalPhase::Committed,
            RemovalPhase::CleanupPending,
        ] {
            if next == RemovalPhase::CleanupPending {
                operation.last_error = Some("retained cleanup failure".to_owned());
            }
            removal.advance(next, &mut operation, &store).unwrap();
            assert_eq!(
                store.get(&operation.id).unwrap().unwrap().phase,
                next.stored()
            );
        }
        assert_eq!(
            store
                .get(&operation.id)
                .unwrap()
                .unwrap()
                .last_error
                .as_deref(),
            Some("retained cleanup failure")
        );
        assert!(
            removal
                .advance(RemovalPhase::Quarantining, &mut operation, &store)
                .is_err()
        );
    }
}

impl RemovalPhase {
    fn stored(self) -> LifecyclePhase {
        match self {
            Self::Quarantining => LifecyclePhase::Preparing,
            Self::Quarantined => LifecyclePhase::PayloadPublished,
            Self::Committed => LifecyclePhase::MetadataCommitted,
            Self::CleanupPending => LifecyclePhase::CleanupPending,
        }
    }
}

/// Checked interpretation of stored removal intent, never consent or path authority.
pub(crate) struct RemovalOperation {
    id: String,
    port_id: String,
    created_at: i64,
    quarantine: PathBuf,
    original_paths: Vec<PathBuf>,
    pub(crate) phase: RemovalPhase,
}

impl RemovalOperation {
    fn validate_envelope(operation: &LifecycleOperation) -> Result<()> {
        for identity in [&operation.id, &operation.port_id] {
            crate::portable_tree::validate_relative_path(identity, false)?;
            let mut components = Path::new(identity).components();
            if !matches!(components.next(), Some(Component::Normal(_)))
                || components.next().is_some()
            {
                return Err(PortcoveError::state(
                    "removal journal has an invalid identity",
                ));
            }
        }
        if operation.kind != LifecycleOperationKind::Remove
            || operation.install.is_some()
            || operation.relocation.is_some()
            || operation.source_import.is_some()
            || operation.preparation.is_some()
            || operation.preparation_process_quiesced.is_some()
            || operation.activate
            || operation.paths.staging.is_some()
            || operation.paths.final_path.is_some()
        {
            return Err(PortcoveError::state(
                "removal journal has an incompatible family payload",
            ));
        }
        Ok(())
    }

    pub(crate) fn decode(library: &Library, operation: &LifecycleOperation) -> Result<Self> {
        Self::validate_envelope(operation)?;
        let quarantine = library.recovery_dir().join(&operation.id);
        if operation.paths.quarantine.as_ref() != Some(&quarantine) {
            return Err(PortcoveError::state(
                "removal journal has an incompatible quarantine path",
            ));
        }
        refuse_symlink_ancestors(&quarantine)?;
        let phase = match operation.phase {
            LifecyclePhase::Preparing => RemovalPhase::Quarantining,
            LifecyclePhase::PayloadPublished => RemovalPhase::Quarantined,
            LifecyclePhase::MetadataCommitted => RemovalPhase::Committed,
            LifecyclePhase::CleanupPending => RemovalPhase::CleanupPending,
            LifecyclePhase::Prepared => {
                return Err(PortcoveError::state(
                    "removal journal has an incompatible phase",
                ));
            }
        };
        Ok(Self {
            id: operation.id.clone(),
            port_id: operation.port_id.clone(),
            created_at: operation.created_at,
            quarantine,
            original_paths: operation.original_paths.clone(),
            phase,
        })
    }

    pub(crate) fn paths(&self, library: &Library) -> Result<Vec<crate::output_root::RemovalPaths>> {
        refuse_symlink_ancestors(&self.quarantine)?;
        self.original_paths
            .iter()
            .map(|path| crate::output_root::removal_paths(library, &self.port_id, &self.id, path))
            .collect()
    }

    pub(crate) fn advance(
        &mut self,
        next: RemovalPhase,
        operation: &mut LifecycleOperation,
        store: &OperationStore,
    ) -> Result<()> {
        Self::validate_envelope(operation)?;
        if operation.id != self.id
            || operation.port_id != self.port_id
            || operation.created_at != self.created_at
            || operation.paths.quarantine.as_ref() != Some(&self.quarantine)
            || operation.original_paths != self.original_paths
            || operation.phase != self.phase.stored()
            || !matches!(
                (self.phase, next),
                (RemovalPhase::Quarantining, RemovalPhase::Quarantined)
                    | (RemovalPhase::Quarantined, RemovalPhase::Committed)
                    | (RemovalPhase::Committed, RemovalPhase::CleanupPending)
            )
        {
            return Err(PortcoveError::state("illegal removal phase transition"));
        }
        operation.phase = next.stored();
        if next != RemovalPhase::CleanupPending {
            operation.last_error = None;
        }
        store.put(operation)?;
        self.phase = next;
        Ok(())
    }
}
