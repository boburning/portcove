//! Checked publication interpretation of the released install/adopt/prepare row.
use super::{LifecycleOperation, LifecycleOperationKind, LifecyclePhase, OperationStore};
use crate::{Library, PortcoveError, Result};

pub(crate) fn validate_envelope(record: &LifecycleOperation) -> Result<()> {
    use LifecycleOperationKind::*;
    record.validate_family()?;
    if !matches!(record.kind, Install | Adopt | Prepare)
        || record.update_acquisition.is_some()
        || record.backup_deletion.is_some()
        || record.ghostship_recovery.is_some()
        || !record.original_paths.is_empty()
        || record.paths.quarantine.is_some()
        || (record.kind == Prepare && record.preparation.is_none())
    {
        return Err(PortcoveError::state(
            "publication journal contains another lifecycle family's intent",
        ));
    }
    Ok(())
}

/// Normal writers retain a checked family from private preparation through
/// publication. The raw record is exposed only as a read-only codec envelope.
#[derive(Clone)]
pub(crate) struct PublicationJournal {
    record: LifecycleOperation,
}

impl PublicationJournal {
    pub(crate) fn begin(record: LifecycleOperation) -> Result<Self> {
        validate_envelope(&record)?;
        if record.phase != LifecyclePhase::Preparing || record.install.is_some() {
            return Err(PortcoveError::state(
                "publication must start with private preparation",
            ));
        }
        Ok(Self { record })
    }

    fn require_private(&self) -> Result<()> {
        if self.record.phase != LifecyclePhase::Preparing || self.record.install.is_some() {
            return Err(PortcoveError::state(
                "publication private intent is already sealed",
            ));
        }
        Ok(())
    }

    pub(crate) fn set_staging(&mut self, path: std::path::PathBuf) -> Result<()> {
        self.require_private()?;
        if self.record.paths.staging.is_some() {
            return Err(PortcoveError::state("publication staging is already bound"));
        }
        self.record.paths.staging = Some(path);
        Ok(())
    }

    pub(crate) fn set_destination(&mut self, path: std::path::PathBuf) -> Result<()> {
        self.require_private()?;
        if self.record.paths.final_path.is_some() {
            return Err(PortcoveError::state(
                "publication destination is already bound",
            ));
        }
        self.record.paths.final_path = Some(path);
        Ok(())
    }

    pub(crate) fn persist(&mut self, store: &OperationStore) -> Result<()> {
        validate_envelope(&self.record)?;
        if self.record.phase != LifecyclePhase::Preparing && self.record.install.is_some() {
            PublicationOperation::decode(&store.library, &mut self.record)?;
        }
        store.put(&mut self.record)
    }

    pub(crate) fn record_process_quiescence(
        &mut self,
        value: bool,
        store: &OperationStore,
    ) -> Result<()> {
        self.require_private()?;
        // A potentially started worker must never inherit an in-memory true
        // proof if recording its start fails. Completion is published only after
        // its journal write succeeds.
        if !value {
            self.record.preparation_process_quiesced = Some(false);
            return self.persist(store);
        }
        let mut candidate = self.clone();
        candidate.record.preparation_process_quiesced = Some(true);
        candidate.persist(store)?;
        *self = candidate;
        Ok(())
    }

    pub(crate) fn prepare(
        &mut self,
        install: crate::InstallRecord,
        store: &OperationStore,
    ) -> Result<()> {
        self.require_private()?;
        if self.record.paths.final_path.as_ref() != Some(&install.path) {
            return Err(PortcoveError::state(
                "new publication destination is not bound to its install",
            ));
        }
        let mut candidate = self.clone();
        candidate.record.install = Some(install);
        candidate.record.phase = LifecyclePhase::Prepared;
        PublicationOperation::decode(&store.library, &mut candidate.record)?;
        *self = candidate;
        // Preserve the in-memory publication barrier even when persistence
        // fails: error cleanup must not mistake a sealed payload for private work.
        self.persist(store)
    }

    pub(crate) fn advance(&mut self, phase: LifecyclePhase, store: &OperationStore) -> Result<()> {
        PublicationOperation::decode(&store.library, &mut self.record)?.advance(phase, store)
    }

    pub(crate) fn retain_cleanup(&mut self, error: String, store: &OperationStore) -> Result<()> {
        if !matches!(
            self.record.phase,
            LifecyclePhase::Preparing | LifecyclePhase::MetadataCommitted
        ) {
            return Err(PortcoveError::state(
                "publication cannot enter cleanup from this phase",
            ));
        }
        self.record.phase = LifecyclePhase::CleanupPending;
        self.record.last_error = Some(error);
        self.persist(store)
    }

    pub(crate) fn record_error(&mut self, error: String, store: &OperationStore) -> Result<()> {
        self.record.last_error = Some(error);
        self.persist(store)
    }

    /// Recovery consumes the released codec envelope and immediately checks the
    /// relevant interrupted-operation representation again under recovery locks.
    pub(crate) fn into_record(self) -> LifecycleOperation {
        self.record
    }
}

impl std::ops::Deref for PublicationJournal {
    type Target = LifecycleOperation;
    fn deref(&self) -> &Self::Target {
        &self.record
    }
}

/// A borrowed checked journal owns the only mutable access during publication.
/// Reads may use the retained envelope; phase changes must use `advance`.
pub(crate) struct PublicationOperation<'a> {
    record: &'a mut LifecycleOperation,
}

impl<'a> PublicationOperation<'a> {
    pub(crate) fn decode(library: &Library, record: &'a mut LifecycleOperation) -> Result<Self> {
        validate_envelope(record)?;
        if record.phase == LifecyclePhase::Preparing {
            return Err(PortcoveError::state(
                "private preparation was interrupted before validation",
            ));
        }
        let install = record.install.as_ref().ok_or_else(|| {
            PortcoveError::state("recoverable publication is missing its install record")
        })?;
        if install.port_id != record.port_id {
            return Err(PortcoveError::state(
                "publication install owner differs from its journal owner",
            ));
        }
        // Released journals may omit this redundant slot. An explicit slot
        // still binds exactly to the retained installation destination.
        if record
            .paths
            .final_path
            .as_ref()
            .is_some_and(|path| path != &install.path)
        {
            return Err(PortcoveError::state(
                "publication install destination differs from its journal destination",
            ));
        }
        let staging = record.paths.staging.as_ref().ok_or_else(|| {
            PortcoveError::state("recoverable publication is missing its staging path")
        })?;
        crate::output_root::validate_staging_path(library, &record.port_id, &record.id, staging)?;
        Ok(Self { record })
    }

    pub(crate) fn advance(&mut self, next: LifecyclePhase, store: &OperationStore) -> Result<()> {
        if !matches!(
            (self.record.phase, next),
            (LifecyclePhase::Prepared, LifecyclePhase::PayloadPublished)
                | (
                    LifecyclePhase::PayloadPublished,
                    LifecyclePhase::MetadataCommitted
                )
        ) {
            return Err(PortcoveError::state("illegal publication phase transition"));
        }
        self.record.phase = next;
        self.record.last_error = None;
        store.put(self.record)
    }
}

impl std::ops::Deref for PublicationOperation<'_> {
    type Target = LifecycleOperation;
    fn deref(&self) -> &Self::Target {
        self.record
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prepared(library: &Library) -> LifecycleOperation {
        let id = uuid::Uuid::new_v4().to_string();
        let destination = library.versions_dir().join("sample").join("a".repeat(64));
        let mut raw = LifecycleOperation::new(&id, LifecycleOperationKind::Install, "sample");
        raw.paths.staging = Some(library.staging_dir().join(&id));
        raw.paths.final_path = Some(destination.clone());
        raw.phase = LifecyclePhase::Prepared;
        raw.install = Some(crate::InstallRecord {
            id,
            port_id: "sample".into(),
            version: "1".into(),
            path: destination,
            channel: crate::ReleaseChannel::Stable,
            installed_at: 1,
            verified: true,
            staged: true,
            artifact: crate::ArtifactIdentity::default(),
            runtime: None,
            manifest_sha256: "a".repeat(64),
            selected_executable: "game.exe".into(),
        });
        raw
    }

    #[test]
    fn publication_checks_identity_paths_family_and_transition_before_mutation() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let original = prepared(&library);
        for case in 0..10 {
            let mut raw = original.clone();
            match case {
                0 => raw.kind = LifecycleOperationKind::Restore,
                1 => raw.install = None,
                2 => raw.install.as_mut().unwrap().port_id = "foreign".into(),
                3 => raw.paths.final_path = Some(library.root().join("foreign")),
                4 => raw.paths.staging = None,
                5 => raw.paths.staging = Some(library.root().join("foreign")),
                6 => raw.phase = LifecyclePhase::Preparing,
                7 => raw.original_paths.push(library.root().join("player-data")),
                8 => raw.paths.quarantine = Some(library.root().join("player-data")),
                9 => raw.removal_installs = Some(Vec::new()),
                _ => unreachable!(),
            }
            assert!(
                PublicationOperation::decode(&library, &mut raw).is_err(),
                "case {case}"
            );
        }
        let mut raw = original.clone();
        let store = OperationStore::new(library.clone());
        store.put(&mut raw).unwrap();
        let install_before = serde_json::to_value(raw.install.as_ref().unwrap()).unwrap();
        let mut operation = PublicationOperation::decode(&library, &mut raw).unwrap();
        assert!(
            operation
                .advance(LifecyclePhase::MetadataCommitted, &store)
                .is_err()
        );
        assert_eq!(
            store.get(&operation.id).unwrap().unwrap().phase,
            LifecyclePhase::Prepared
        );
        operation
            .advance(LifecyclePhase::PayloadPublished, &store)
            .unwrap();
        operation
            .advance(LifecyclePhase::MetadataCommitted, &store)
            .unwrap();
        assert!(operation.advance(LifecyclePhase::Prepared, &store).is_err());
        let retained = store.get(&operation.id).unwrap().unwrap();
        assert_eq!(retained.phase, LifecyclePhase::MetadataCommitted);
        assert_eq!(
            serde_json::to_value(retained.install.as_ref().unwrap()).unwrap(),
            install_before
        );
        assert!(!retained.install.unwrap().path.exists());
        assert!(!retained.paths.staging.unwrap().exists());
    }

    #[test]
    fn malformed_persisted_payload_is_refused_and_retained_for_recovery() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let mut raw = prepared(&library);
        let store = OperationStore::new(library.clone());
        store.put(&mut raw).unwrap();
        // Simulate corruption at the untrusted codec boundary, not a valid writer.
        let connection = crate::database::connect(library.root()).unwrap();
        connection
            .execute(
                "UPDATE lifecycle_operations SET removal_installs_json='[]' WHERE id=?1",
                [&raw.id],
            )
            .unwrap();
        assert!(store.get(&raw.id).is_err());
        assert!(store.all().is_err());
        let retained: String = connection
            .query_row(
                "SELECT removal_installs_json FROM lifecycle_operations WHERE id=?1",
                [&raw.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            retained, "[]",
            "failed interpretation must preserve the original row"
        );
    }

    #[test]
    fn released_omitted_destination_recovers_but_new_publication_requires_binding() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let store = OperationStore::new(library.clone());
        let mut raw = prepared(&library);
        let install = raw.install.clone().unwrap();
        raw.paths.final_path = None;
        store.put(&mut raw).unwrap();
        let mut released = store.get(&raw.id).unwrap().unwrap();
        assert!(PublicationOperation::decode(&library, &mut released).is_ok());
        raw.phase = LifecyclePhase::Preparing;
        raw.install = None;
        let mut writer = PublicationJournal::begin(raw).unwrap();
        assert!(writer.prepare(install, &store).is_err());
        assert_eq!(writer.phase, LifecyclePhase::Preparing);
    }

    #[test]
    fn private_cleanup_refuses_foreign_publication_intent_and_preserves_tree_and_row() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let service = crate::PortcoveService::new(library.clone()).unwrap();
        let store = OperationStore::new(library.clone());
        let mut raw = prepared(&library);
        raw.phase = LifecyclePhase::CleanupPending;
        raw.install = None;
        let staging = raw.paths.staging.clone().unwrap();
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::write(staging.join("sentinel"), b"retained private input").unwrap();
        for foreign in 0..2 {
            let mut malformed = raw.clone();
            if foreign == 0 {
                malformed.original_paths.push(library.user_dir("sample"));
            } else {
                malformed.paths.quarantine = Some(library.recovery_dir().join("foreign"));
            }
            store.put(&mut malformed).unwrap();
            assert!(
                crate::recovery::recover_published_install(&service, &store, &mut malformed)
                    .is_err()
            );
            assert_eq!(
                std::fs::read(staging.join("sentinel")).unwrap(),
                b"retained private input"
            );
            assert!(store.get(&raw.id).unwrap().is_some());
        }
    }
}
