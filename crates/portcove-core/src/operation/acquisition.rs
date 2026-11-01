//! Codec, owned identity and transactional reservation rules for immutable acquisitions.
//! This layer does not orchestrate downloads, resource admission or runtime mutation.
use super::{LifecycleOperation, LifecycleOperationKind, LifecyclePhase};
use crate::path::refuse_symlink_ancestors;
use crate::{GameUpdateAcquisition, Library, PortcoveError, Result};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::PathBuf};
use uuid::Uuid;

/// Checked interpretation of the released lifecycle envelope. Orchestration can
/// inspect intent and advance its phase, but cannot mutate its owner or payload.
pub(crate) struct AcquisitionOperation {
    record: LifecycleOperation,
}

impl AcquisitionOperation {
    pub(crate) fn reserve(library: &Library, payload: AcquisitionJournal) -> Result<Self> {
        if payload.view.phase != crate::GameUpdateAcquisitionPhase::Acquiring {
            return Err(PortcoveError::state("acquisition must start by acquiring"));
        }
        let mut record = LifecycleOperation::new(
            &payload.view.id,
            LifecycleOperationKind::AcquireUpdate,
            &payload.view.port_id,
        );
        record.paths.staging = Some(root(library, &record.id)?);
        record.update_acquisition = Some(payload);
        Self::decode(library, record)
    }

    pub(crate) fn decode(library: &Library, record: LifecycleOperation) -> Result<Self> {
        if record.kind != LifecycleOperationKind::AcquireUpdate {
            return Err(PortcoveError::verification("journal is not an acquisition"));
        }
        validate_journal(library, &record)?;
        Ok(Self { record })
    }

    pub(crate) fn payload(&self) -> &AcquisitionJournal {
        self.record
            .update_acquisition
            .as_ref()
            .expect("checked acquisition")
    }

    pub(crate) fn id(&self) -> &str {
        &self.record.id
    }
    pub(crate) fn port_id(&self) -> &str {
        &self.record.port_id
    }
    pub(crate) fn created_at(&self) -> i64 {
        self.record.created_at
    }
    pub(crate) fn last_error(&self) -> Option<&str> {
        self.record.last_error.as_deref()
    }

    pub(crate) fn persist(&mut self, store: &super::OperationStore) -> Result<()> {
        store.put(&mut self.record)
    }

    pub(crate) fn advance(
        &mut self,
        next: crate::GameUpdateAcquisitionPhase,
        error: Option<String>,
        store: &super::OperationStore,
    ) -> Result<()> {
        use crate::GameUpdateAcquisitionPhase::*;
        if !matches!(
            (self.payload().view.phase, next),
            (Acquiring, Verifying)
                | (Verifying, Acquired)
                | (
                    Acquiring | Verifying | Acquired | AttentionRequired,
                    AttentionRequired
                )
        ) || (next != AttentionRequired && error.is_some())
        {
            return Err(PortcoveError::state("illegal acquisition phase transition"));
        }
        let mut candidate = self.record.clone();
        let payload = candidate
            .update_acquisition
            .as_mut()
            .expect("checked acquisition");
        payload.view.phase = next;
        // Preserve the released view timestamp contract: verification changes
        // the journal phase; terminal acquisition observations refresh the view.
        if next != Verifying {
            payload.view.updated_at = Library::now();
        }
        candidate.last_error = error;
        store.put(&mut candidate)?;
        self.record = candidate;
        Ok(())
    }
}

pub(crate) const MAX_RECORD_BYTES: usize = 64 * 1024;
pub(crate) const MAX_RECORDS: usize = 256;
pub(crate) const MAX_BYTES: u64 = 8 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct AcquisitionJournal {
    pub view: GameUpdateAcquisition,
    pub definition_sha256: String,
    pub assets: Vec<crate::ReleaseAsset>,
}

pub(crate) fn root(library: &Library, id: &str) -> Result<PathBuf> {
    Uuid::parse_str(id).map_err(|_| PortcoveError::verification("invalid acquisition ID"))?;
    let root = library
        .downloads_dir()
        .join("update-acquisition-v1")
        .join(id);
    refuse_symlink_ancestors(&root)?;
    Ok(root)
}
pub(crate) fn decode_journal(json: Option<&str>) -> Result<Option<AcquisitionJournal>> {
    json.map(|json| {
        if json.len() > MAX_RECORD_BYTES {
            return Err(PortcoveError::verification(
                "acquisition record exceeds its byte bound",
            ));
        }
        Ok(serde_json::from_str(json)?)
    })
    .transpose()
}
pub(crate) fn validate_journal(library: &Library, operation: &LifecycleOperation) -> Result<()> {
    if operation.kind != LifecycleOperationKind::AcquireUpdate {
        return if operation.update_acquisition.is_none() {
            Ok(())
        } else {
            Err(PortcoveError::verification(
                "another lifecycle family cannot own update acquisition",
            ))
        };
    }
    let payload = operation
        .update_acquisition
        .as_ref()
        .ok_or_else(|| PortcoveError::verification("acquisition lost its typed journal"))?;
    let bytes = payload.assets.iter().try_fold(0_u64, |total, asset| {
        crate::archive::validate_download_progress(0, asset.size)?;
        if asset.size == 0 {
            return Err(PortcoveError::verification(
                "immutable acquisition requires an independently bounded nonzero asset size",
            ));
        }
        if asset.sha256.len() != 64 || !asset.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(PortcoveError::verification(
                "acquisition requires an independently expected SHA-256",
            ));
        }
        total
            .checked_add(asset.size)
            .ok_or_else(|| PortcoveError::verification("acquisition capacity overflow"))
    })?;
    let staging_matches = match operation.paths.staging.as_deref() {
        Some(staging) if staging.is_absolute() => {
            refuse_symlink_ancestors(staging)?;
            let expected = root(library, &operation.id)?;
            // Reopening a Windows library through its verbatim alias keeps the same owner.
            crate::path::normalized_absolute(staging, "acquisition staging")?
                == crate::path::normalized_absolute(&expected, "owned acquisition staging")?
        }
        _ => false,
    };
    if operation.id != payload.view.id
        || operation.port_id != payload.view.port_id
        || !staging_matches
        || operation.phase != LifecyclePhase::Preparing
        || operation.activate
        || operation.install.is_some()
        || operation.relocation.is_some()
        || operation.source_import.is_some()
        || operation.preparation.is_some()
        || operation.ghostship_recovery.is_some()
        || operation.backup_deletion.is_some()
        || operation.preparation_process_quiesced.is_some()
        || operation.external_registration_sha256.is_some()
        || operation.removal_installs.is_some()
        || operation.paths.final_path.is_some()
        || operation.paths.quarantine.is_some()
        || !operation.original_paths.is_empty()
        || !(1..=2).contains(&payload.assets.len())
        || payload.assets[0] != payload.view.release.asset
        || bytes > MAX_BYTES
        || payload.definition_sha256.len() != 64
    {
        return Err(PortcoveError::verification(
            "acquisition journal has foreign ownership, paths or intent",
        ));
    }
    Ok(())
}

/// Serialized with insertion/update: partial reservations and every bundled asset count.
pub(crate) fn require_capacity(
    connection: &Connection,
    operation: &LifecycleOperation,
    json: Option<&str>,
) -> Result<()> {
    let Some(json) = json else {
        return Ok(());
    };
    if json.len() > MAX_RECORD_BYTES {
        return Err(PortcoveError::conflict("acquisition record exceeds 64 KiB"));
    }
    let mut statement = connection.prepare("SELECT id,port_id,update_acquisition_json FROM lifecycle_operations WHERE kind='acquire_update' AND id<>?1 LIMIT 257")?;
    let rows = statement.query_map([&operation.id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
        ))
    })?;
    let payload = operation
        .update_acquisition
        .as_ref()
        .expect("validated acquisition");
    let mut bytes = payload.assets.iter().map(|asset| asset.size).sum::<u64>();
    let mut count = 1;
    for row in rows {
        let (_, port_id, json) = row?;
        if port_id == operation.port_id {
            return Err(PortcoveError::conflict(
                "discard the existing acquired archive before downloading another update",
            ));
        }
        let other = decode_journal(json.as_deref())?
            .ok_or_else(|| PortcoveError::verification("acquisition reservation is missing"))?;
        count += 1;
        for asset in other.assets {
            bytes = bytes.saturating_add(asset.size);
        }
    }
    if count > MAX_RECORDS || bytes > MAX_BYTES {
        return Err(PortcoveError::conflict(
            "retained acquisitions exceed 256 records or 8 GiB; discard an owned archive before retrying",
        ));
    }
    Ok(())
}

pub(crate) fn views_from(
    connection: &Connection,
) -> Result<HashMap<String, GameUpdateAcquisition>> {
    let mut statement = connection.prepare("SELECT id,port_id,update_acquisition_json FROM lifecycle_operations WHERE kind='acquire_update' LIMIT 257")?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
        ))
    })?;
    let mut result = HashMap::new();
    for row in rows {
        let (id, port_id, json) = row?;
        let payload = decode_journal(json.as_deref())?
            .ok_or_else(|| PortcoveError::verification("acquisition state is missing"))?;
        if payload.view.id != id
            || Uuid::parse_str(&id).is_err()
            || payload.view.port_id != port_id
            || result.len() >= MAX_RECORDS
            || result.insert(port_id, payload.view).is_some()
        {
            return Err(PortcoveError::verification(
                "acquisition inventory has duplicate or over-bound owners",
            ));
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{GameUpdateAcquisitionPhase as Phase, Platform, ReleaseChannel, ResolvedRelease};

    fn reserved(library: &Library) -> LifecycleOperation {
        let id = Uuid::new_v4().to_string();
        let asset = crate::ReleaseAsset {
            name: "inert.zip".into(),
            url: "https://example.invalid/inert.zip".into(),
            size: 3,
            sha256: "a".repeat(64),
        };
        AcquisitionOperation::reserve(
            library,
            AcquisitionJournal {
                view: GameUpdateAcquisition {
                    id,
                    port_id: "sample".into(),
                    platform: Platform::WindowsX86_64,
                    release: ResolvedRelease {
                        version: "1".into(),
                        channel: ReleaseChannel::Stable,
                        published_at: None,
                        asset: asset.clone(),
                    },
                    phase: Phase::Acquiring,
                    created_at: 1,
                    updated_at: 1,
                },
                definition_sha256: "b".repeat(64),
                assets: vec![asset],
            },
        )
        .unwrap()
        .record
    }

    #[test]
    fn acquisition_kind_phase_and_payload_matrix_fails_before_storage_or_files() {
        use LifecycleOperationKind::*;
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let original = reserved(&library);
        let staging = original.paths.staging.clone().unwrap();
        let store = super::super::OperationStore::new(library.clone());
        for kind in [
            Install,
            AcquireUpdate,
            Prepare,
            Adopt,
            Remove,
            Restore,
            DeleteBackup,
            Activate,
            Relocate,
            ImportSource,
            GhostshipRecovery,
        ] {
            for phase in [
                LifecyclePhase::Preparing,
                LifecyclePhase::Prepared,
                LifecyclePhase::PayloadPublished,
                LifecyclePhase::MetadataCommitted,
                LifecyclePhase::CleanupPending,
            ] {
                let mut raw = original.clone();
                raw.kind = kind;
                raw.phase = phase;
                assert_eq!(
                    AcquisitionOperation::decode(&library, raw.clone()).is_ok(),
                    kind == AcquireUpdate && phase == LifecyclePhase::Preparing,
                    "{kind:?}/{phase:?}"
                );
                if kind != AcquireUpdate || phase != LifecyclePhase::Preparing {
                    assert!(store.put(&mut raw).is_err(), "{kind:?}/{phase:?}");
                }
            }
        }
        for change in 0..9 {
            let mut raw = original.clone();
            match change {
                0 => raw.update_acquisition = None,
                1 => raw.port_id = "foreign".into(),
                2 => raw.id = Uuid::new_v4().to_string(),
                3 => raw.removal_installs = Some(Vec::new()),
                4 => raw.paths.final_path = Some(staging.join("foreign")),
                5 => raw.original_paths.push(staging.clone()),
                6 => raw.preparation_process_quiesced = Some(true),
                7 => raw.activate = true,
                8 => raw.paths.staging = Some(library.staging_dir().join(&raw.id)),
                _ => unreachable!(),
            }
            assert!(
                AcquisitionOperation::decode(&library, raw.clone()).is_err(),
                "case {change}"
            );
            assert!(store.put(&mut raw).is_err(), "case {change}");
        }
        assert!(store.all().unwrap().is_empty());
        assert!(
            !staging.exists(),
            "validation must not create acquisition content"
        );
    }

    #[test]
    fn acquisition_released_shape_roundtrips_and_only_legal_transitions_persist() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let store = super::super::OperationStore::new(library.clone());
        let raw = reserved(&library);
        let retained_payload =
            serde_json::to_string(raw.update_acquisition.as_ref().unwrap()).unwrap();
        assert_eq!(
            serde_json::to_string(&decode_journal(Some(&retained_payload)).unwrap().unwrap())
                .unwrap(),
            retained_payload
        );
        let mut operation = AcquisitionOperation::decode(&library, raw).unwrap();
        operation.persist(&store).unwrap();
        assert!(operation.advance(Phase::Acquired, None, &store).is_err());
        assert_eq!(
            store
                .get(operation.id())
                .unwrap()
                .unwrap()
                .update_acquisition
                .unwrap()
                .view
                .phase,
            Phase::Acquiring
        );
        operation.advance(Phase::Verifying, None, &store).unwrap();
        operation.advance(Phase::Acquired, None, &store).unwrap();
        let reopened = store.get(operation.id()).unwrap().unwrap();
        let mut checked = AcquisitionOperation::decode(&library, reopened).unwrap();
        assert_eq!(checked.payload().view.phase, Phase::Acquired);
        assert!(checked.advance(Phase::Acquiring, None, &store).is_err());
        assert!(checked.advance(Phase::Verifying, None, &store).is_err());
        checked
            .advance(
                Phase::AttentionRequired,
                Some("retained failure".into()),
                &store,
            )
            .unwrap();
        let reopened = store.get(checked.id()).unwrap().unwrap();
        assert_eq!(reopened.last_error.as_deref(), Some("retained failure"));
        let actual = reopened.update_acquisition.unwrap();
        let expected = decode_journal(Some(&retained_payload)).unwrap().unwrap();
        assert_eq!(actual.assets, expected.assets);
        assert_eq!(actual.definition_sha256, expected.definition_sha256);
        assert_eq!(actual.view.release, expected.view.release);
    }
}
