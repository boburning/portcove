//! Immutable update bytes. This journal never owns installed runtime or player data.
use super::*;
use crate::{GameUpdateAcquisition, GameUpdateAcquisitionPhase as Phase};
use rusqlite::Connection;
use std::{
    collections::HashMap,
    fs::OpenOptions,
    io::{Read, Write},
};

const MAX_RECORD_BYTES: usize = 64 * 1024;
const MAX_RECORDS: usize = 256;
const MAX_BYTES: u64 = 8 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct AcquisitionJournal {
    pub view: GameUpdateAcquisition,
    pub definition_sha256: String,
    pub assets: Vec<crate::ReleaseAsset>,
}

/// Ephemeral validated input lease. Neither its files nor a retained journal grants authority.
pub(crate) struct AcquiredInputs {
    files: Vec<(crate::ReleaseAsset, PathBuf)>,
    _guard: crate::PortOperationGuard,
}
impl AcquiredInputs {
    pub(crate) fn path(&self, asset: &crate::ReleaseAsset) -> Result<&Path> {
        self.files
            .iter()
            .find(|(expected, _)| expected == asset)
            .map(|(_, path)| path.as_path())
            .ok_or_else(|| {
                PortcoveError::conflict("acquired update does not contain these exact bytes")
            })
    }
}

fn root(library: &Library, id: &str) -> Result<PathBuf> {
    Uuid::parse_str(id).map_err(|_| PortcoveError::verification("invalid acquisition ID"))?;
    let root = library
        .downloads_dir()
        .join("update-acquisition-v1")
        .join(id);
    refuse_symlink_ancestors(&root)?;
    Ok(root)
}
fn definition_digest(port: &PortDefinition) -> Result<String> {
    Ok(crate::signed_catalog::digest(&serde_json::to_vec(port)?))
}
fn assets_for(plan: &crate::InstallPlan) -> Vec<crate::ReleaseAsset> {
    std::iter::once(plan.release.asset.clone())
        .chain(
            plan.bundled_runtime
                .as_ref()
                .map(|runtime| runtime.asset.clone()),
        )
        .collect()
}
fn file(root: &Path, index: usize) -> PathBuf {
    root.join(format!("{index}.archive"))
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

impl PortcoveService {
    /// Optimistic read-only review: immutable transfer never needs the runtime mutation lock.
    /// Execution repeats these facts under its separate acquisition-owner lock.
    pub async fn plan_game_update_acquisition(
        &self,
        port_id: &str,
    ) -> Result<crate::GameUpdatePlan> {
        let reviewed = self.plan_game_update_locked(port_id, false).await?;
        self.require_acquisition_plan(&reviewed)?;
        Ok(reviewed)
    }

    pub async fn authorize_game_update_acquisition(
        &self,
        port_id: &str,
        expected_plan: &str,
    ) -> Result<crate::DestructiveAuthorization> {
        let reviewed = self.plan_game_update_acquisition(port_id).await?;
        if reviewed.plan_sha256 != expected_plan {
            return Err(PortcoveError::conflict(
                "update inputs changed; review acquisition again",
            ));
        }
        self.require_acquisition_plan(&reviewed)?;
        self.library
            .issue_authorization("game-update-acquisition", port_id, expected_plan)
    }

    fn require_acquisition_plan(&self, reviewed: &crate::GameUpdatePlan) -> Result<()> {
        if reviewed.plan.action != crate::InstallPlanAction::Download
            || reviewed.assessment.availability != crate::PortActionAvailability::Allowed
        {
            return Err(PortcoveError::verification(
                "this update is not ready for immutable acquisition; retain its source and installation requirements",
            ));
        }
        let status = self.status(&reviewed.plan.port_id)?;
        if status.acquisition.is_some() {
            return Err(PortcoveError::conflict(
                "discard the existing archive before another acquisition",
            ));
        }
        let active = status
            .active
            .as_ref()
            .filter(|active| active.verified)
            .ok_or_else(|| {
                PortcoveError::verification(
                    "immutable acquisition requires a verified current managed runtime",
                )
            })?;
        let qualification = self.installed_mutability_qualification(active)?;
        Installer::new(self.library.clone())?.verify_critical(active, &qualification)?;
        Ok(())
    }

    pub async fn acquire_game_update(
        &self,
        port_id: &str,
        authorization: &str,
        mut emit: impl FnMut(OperationEvent),
    ) -> Result<GameUpdateAcquisition> {
        #[cfg(test)]
        let observed = std::time::Instant::now();
        #[cfg(test)]
        eprintln!(
            "immutable acquisition phase: activity ownership ({:?})",
            observed.elapsed()
        );
        let (activity, operation) = self.begin_cancellable_activity(
            ActivityOperation::DownloadPackage,
            ActivityTargetKind::Port,
            Some(port_id),
        )?;
        emit(operation.started());
        let store = OperationStore::new(self.library.clone());
        let mut journal = None;
        let result = async {
            let _acquisition_owner = self.library.try_lock_update_acquisition(port_id)?;
            let reviewed = {
                #[cfg(test)]
                eprintln!("immutable acquisition phase: fresh review ({:?})", observed.elapsed());
                let reviewed = operation
                    .interruptible(self.plan_game_update_locked(port_id, false))
                    .await?;
                #[cfg(test)]
                eprintln!("immutable acquisition phase: current-runtime verification and authorization ({:?})", observed.elapsed());
                self.require_acquisition_plan(&reviewed)?;
                self.library.consume_authorization(
                    authorization,
                    "game-update-acquisition",
                    port_id,
                    &reviewed.plan_sha256,
                )?;
                let now = Library::now();
                let view = GameUpdateAcquisition {
                    id: activity.id.clone(),
                    port_id: port_id.into(),
                    platform: Platform::current()?,
                    release: reviewed.plan.release.clone(),
                    phase: Phase::Acquiring,
                    created_at: now,
                    updated_at: now,
                };
                let mut record = LifecycleOperation::new(
                    &activity.id,
                    LifecycleOperationKind::AcquireUpdate,
                    port_id,
                );
                record.paths.staging = Some(root(&self.library, &activity.id)?);
                record.update_acquisition = Some(AcquisitionJournal {
                    view,
                    definition_sha256: definition_digest(self.catalog.port(port_id)?)?,
                    assets: assets_for(&reviewed.plan),
                });
                store.put(&mut record)?;
                #[cfg(test)]
                eprintln!("immutable acquisition phase: bounded reservation persisted ({:?})", observed.elapsed());
                journal = Some(record);
                reviewed
            }; // Only private transfer remains; launch keeps its ordinary exclusive lock.
            let record = journal.as_mut().expect("reserved acquisition");
            let private = root(&self.library, &activity.id)?;
            fs::create_dir_all(private.parent().expect("acquisition parent"))?;
            refuse_symlink_ancestors(&private)?;
            fs::create_dir(&private)?;
            let reserved = record
                .update_acquisition
                .as_ref()
                .expect("journal")
                .assets
                .iter()
                .map(|asset| asset.size)
                .sum::<u64>();
            if fs2::available_space(&private)? < reserved {
                return Err(PortcoveError::conflict(
                    "insufficient free space for immutable update archives",
                ));
            }
            let mut marker = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(private.join("owner.pending"))?;
            marker
                .write_all(serde_json::to_string(&(activity.id.as_str(), port_id))?.as_bytes())?;
            marker.sync_all()?;
            drop(marker);
            crate::durability::rename_noreplace(
                &private.join("owner.pending"),
                &private.join("owner.json"),
            )?;
            #[cfg(test)]
            eprintln!("immutable acquisition phase: private ownership durable; provider resolution ({:?})", observed.elapsed());
            let port = self.catalog.port(port_id)?;
            let resolution = self
                .resolve_reviewed_update_acquisition(port, &reviewed.plan.release, &operation)
                .await?;
            let qualification =
                InstallQualification::from_catalog(&self.catalog, port_id, Platform::current()?)?
                    .with_acquisition_resolution(resolution)?;
            let request = InstallRequest {
                port_id: port_id.into(),
                release: reviewed.plan.release,
                output_root: reviewed.plan.output_location.effective_output_directory,
                activate: false,
                managed: None,
                qualification,
            };
            let installer = Installer::new(self.library.clone())?;
            #[cfg(test)]
            eprintln!("immutable acquisition phase: immutable transfer ({:?})", observed.elapsed());
            installer
                .acquire_immutable(&request, &private, &operation, &mut emit)
                .await?;
            #[cfg(test)]
            eprintln!("immutable acquisition phase: archive verification and durability ({:?})", observed.elapsed());
            record
                .update_acquisition
                .as_mut()
                .expect("journal")
                .view
                .phase = Phase::Verifying;
            store.put(record)?;
            let payload = record.update_acquisition.as_ref().expect("journal");
            for (index, asset) in payload.assets.iter().enumerate() {
                let archive = file(&private, index);
                verify_archive(&archive, asset, &operation)?;
                // Windows FlushFileBuffers requires write access even though no bytes change.
                OpenOptions::new().write(true).open(archive)?.sync_all()?;
            }
            crate::durability::sync_publication(&private)?;
            crate::durability::sync_publication(private.parent().expect("acquisition parent"))?;
            // Atomically close cancellation before publishing the completed byte identity.
            operation.begin_publication()?;
            #[cfg(test)]
            eprintln!("immutable acquisition phase: acquired publication ({:?})", observed.elapsed());
            let payload = record.update_acquisition.as_mut().expect("journal");
            payload.view.phase = Phase::Acquired;
            payload.view.updated_at = Library::now();
            store.put(record)?;
            Ok(record
                .update_acquisition
                .as_ref()
                .expect("journal")
                .view
                .clone())
        }
        .await;
        if result.is_err()
            && let Some(record) = journal.as_mut()
        {
            if let Some(payload) = &mut record.update_acquisition {
                payload.view.phase = Phase::AttentionRequired;
                payload.view.updated_at = Library::now();
            }
            record.last_error = result.as_ref().err().map(ToString::to_string);
            if let Err(error) = store.put(record) {
                tracing::warn!(%error,"unable to record acquisition attention state; retained journal remains recoverable");
            }
        }
        let result = self.finish_activity(activity, result);
        emit(operation.finished(OperationResult::from_result(&result)));
        result
    }

    async fn resolve_reviewed_update_acquisition(
        &self,
        port: &PortDefinition,
        release: &ResolvedRelease,
        operation: &OperationCoordinator,
    ) -> Result<crate::ScopedResolvedRelease> {
        let scope = crate::definition_repository::publisher_policy::acquisition_scope(
            &self.library,
            &self.catalog,
            &port.id,
        )?;
        if scope.is_some() || crate::managed_runtime_policy::requires_provider_resolution(port) {
            let resolution = operation
                .interruptible(self.resolve_release(port, release.channel, Platform::current()?))
                .await?;
            if resolution.release != *release {
                return Err(PortcoveError::conflict(
                    "reviewed release changed before immutable acquisition",
                ));
            }
            Ok(resolution)
        } else {
            Ok(crate::ScopedResolvedRelease::legacy(release.clone()))
        }
    }

    pub(crate) fn acquisition_for_review(
        &self,
        status: &PortStatus,
        plan: &crate::InstallPlan,
    ) -> Result<Option<GameUpdateAcquisition>> {
        if plan.action != crate::InstallPlanAction::Download {
            return Ok(None);
        }
        let Some(view) = status.acquisition.as_ref().filter(|view| {
            view.phase == Phase::Acquired
                && view.release == plan.release
                && view.platform == plan.platform
        }) else {
            return Ok(None);
        };
        let record = OperationStore::new(self.library.clone())
            .get(&view.id)?
            .ok_or_else(|| PortcoveError::conflict("acquisition changed during review"))?;
        let payload = record
            .update_acquisition
            .as_ref()
            .filter(|_| {
                record.kind == LifecycleOperationKind::AcquireUpdate
                    && record.port_id == view.port_id
            })
            .ok_or_else(|| PortcoveError::conflict("acquisition owner changed; review again"))?;
        Ok(
            (payload.definition_sha256 == definition_digest(self.catalog.port(&plan.port_id)?)?
                && payload.assets == assets_for(plan))
            .then(|| view.clone()),
        )
    }

    pub(crate) fn acquired_inputs(
        &self,
        reviewed: &crate::GameUpdatePlan,
        operation: &OperationCoordinator,
    ) -> Result<Option<AcquiredInputs>> {
        let Some(view) = &reviewed.acquisition else {
            return Ok(None);
        };
        let guard = self.library.try_lock_activity(&view.id)?;
        let record = OperationStore::new(self.library.clone())
            .get(&view.id)?
            .ok_or_else(|| PortcoveError::conflict("acquired update disappeared; review again"))?;
        let payload = record
            .update_acquisition
            .as_ref()
            .filter(|_| {
                record.kind == LifecycleOperationKind::AcquireUpdate
                    && record.port_id == view.port_id
            })
            .ok_or_else(|| PortcoveError::conflict("acquisition owner changed; review again"))?;
        if payload.view != *view
            || payload.definition_sha256 != definition_digest(self.catalog.port(&view.port_id)?)?
            || payload.assets != assets_for(&reviewed.plan)
        {
            return Err(PortcoveError::conflict(
                "acquired update changed; review again",
            ));
        }
        validate_private_files(&self.library, &record)?;
        for (index, asset) in payload.assets.iter().enumerate() {
            verify_archive(
                &file(&root(&self.library, &view.id)?, index),
                asset,
                operation,
            )?;
        }
        Ok(Some(AcquiredInputs {
            files: payload
                .assets
                .iter()
                .enumerate()
                .map(|(index, asset)| {
                    Ok((asset.clone(), file(&root(&self.library, &view.id)?, index)))
                })
                .collect::<Result<_>>()?,
            _guard: guard,
        }))
    }

    /// Only owned private archives are removed; exact identity and live owner are rechecked.
    pub fn discard_game_update_acquisition(
        &self,
        port_id: &str,
        acquisition_id: &str,
    ) -> Result<()> {
        let _guard = self.library.try_lock_activity(acquisition_id)?;
        let store = OperationStore::new(self.library.clone());
        let Some(record) = store.get(acquisition_id)? else {
            return Err(PortcoveError::not_found("acquisition no longer exists"));
        };
        if record.kind != LifecycleOperationKind::AcquireUpdate || record.port_id != port_id {
            return Err(PortcoveError::verification(
                "acquisition belongs to another resource",
            ));
        }
        validate_private_files(&self.library, &record)?;
        let private = root(&self.library, acquisition_id)?;
        if private.exists() {
            let payload = record
                .update_acquisition
                .as_ref()
                .expect("validated journal");
            for index in 0..payload.assets.len() {
                let path = file(&private, index);
                if path.try_exists()? {
                    fs::remove_file(path)?;
                }
            }
            for name in ["owner.pending", "owner.json"] {
                let marker = private.join(name);
                if marker.try_exists()? {
                    fs::remove_file(marker)?;
                }
            }
            fs::remove_dir(&private)?;
        }
        store.remove(acquisition_id)
    }

    pub(crate) fn recover_game_update_acquisition(
        &self,
        store: &OperationStore,
        candidate: &LifecycleOperation,
    ) -> Result<()> {
        let _owner = match self.library.try_lock_activity(&candidate.id) {
            Ok(guard) => guard,
            Err(error) if error.code == crate::ErrorCode::Conflict => return Ok(()),
            Err(error) => return Err(error),
        };
        let Some(mut current) = store.get(&candidate.id)? else {
            return Ok(());
        };
        if current.created_at != candidate.created_at
            || current.kind != candidate.kind
            || current.port_id != candidate.port_id
        {
            return Ok(());
        }
        let payload = current
            .update_acquisition
            .as_mut()
            .expect("validated journal");
        if payload.view.phase == Phase::Acquired || payload.view.phase == Phase::AttentionRequired {
            let status = if payload.view.phase == Phase::Acquired {
                ActivityStatus::Succeeded
            } else {
                ActivityStatus::Failed
            };
            finish_if_running(
                &self.library,
                &current.id,
                status,
                current.last_error.as_deref().unwrap_or(
                    "Archive download completed; a fresh review is required before preparation",
                ),
            )?;
            return Ok(());
        }
        payload.view.phase = Phase::AttentionRequired;
        payload.view.updated_at = Library::now();
        current.last_error = Some("Archive acquisition was interrupted. Discard this exact private archive and review a new download; no runtime was prepared or activated.".into());
        store.put(&mut current)?;
        finish_if_running(
            &self.library,
            &current.id,
            ActivityStatus::Failed,
            current
                .last_error
                .as_deref()
                .unwrap_or("Archive acquisition requires attention"),
        )?;
        Ok(())
    }
}

fn finish_if_running(
    library: &Library,
    id: &str,
    status: ActivityStatus,
    message: &str,
) -> Result<()> {
    let recorded: String = library.connection()?.query_row(
        "SELECT status FROM activity_history WHERE id=?1",
        [id],
        |row| row.get(0),
    )?;
    if recorded == "running" {
        library.finish_activity(id, status, Some(message))?;
    }
    Ok(())
}

pub(crate) fn verify_archive(
    path: &Path,
    asset: &crate::ReleaseAsset,
    operation: &OperationCoordinator,
) -> Result<()> {
    refuse_symlink_ancestors(path)?;
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(PortcoveError::verification(
            "acquired archive is not a regular file",
        ));
    }
    crate::archive::validate_download_size(metadata.len(), asset.size)?;
    let (hash, size) = crate::adapter::hash_file_bounded_with_checkpoint(path, asset.size, || {
        operation.checkpoint()
    })?;
    crate::archive::validate_download_size(size, asset.size)?;
    if !hash.eq_ignore_ascii_case(&asset.sha256) {
        return Err(PortcoveError::verification(
            "acquired archive failed expected SHA-256 verification",
        ));
    }
    Ok(())
}

/// Joined callers retain the ownership lease until this bounded copy stops mutating.
pub(crate) fn copy_archive(
    source: &Path,
    destination: &Path,
    asset: &crate::ReleaseAsset,
    operation: &OperationCoordinator,
) -> Result<()> {
    verify_archive(source, asset, operation)?;
    refuse_symlink_ancestors(destination)?;
    let mut input = fs::File::open(source)?;
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(destination)?;
    let mut bytes = 0_u64;
    let mut buffer = [0; 64 * 1024];
    loop {
        operation.checkpoint()?;
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        bytes = bytes.saturating_add(count as u64);
        crate::archive::validate_download_progress(bytes, asset.size)?;
        output.write_all(&buffer[..count])?;
    }
    output.sync_all()?;
    drop(output);
    verify_archive(destination, asset, operation)
}

fn validate_private_files(library: &Library, record: &LifecycleOperation) -> Result<()> {
    validate_journal(library, record)?;
    let private = root(library, &record.id)?;
    if !private.try_exists()? {
        return Ok(());
    }
    let metadata = fs::symlink_metadata(&private)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(PortcoveError::verification(
            "acquisition root is not an owned directory",
        ));
    }
    let payload = record
        .update_acquisition
        .as_ref()
        .expect("validated journal");
    let members = fs::read_dir(&private)?
        .take(payload.assets.len() + 3)
        .collect::<std::io::Result<Vec<_>>>()?;
    if members.len() > payload.assets.len() + 2 {
        return Err(PortcoveError::verification(
            "foreign members in acquisition root; retained for review",
        ));
    }
    if members.is_empty() {
        return Ok(());
    }
    let expected = serde_json::to_vec(&(record.id.as_str(), record.port_id.as_str()))?;
    let marker = private.join("owner.json");
    let has_owner = marker.try_exists()?;
    if has_owner && crate::path::read_bounded_regular(&marker, 1024)? != expected {
        return Err(PortcoveError::verification(
            "foreign acquisition owner marker",
        ));
    }
    let pending = private.join("owner.pending");
    if pending.try_exists()? {
        let partial = crate::path::read_bounded_regular(&pending, 1024)?;
        if !expected.starts_with(&partial) {
            return Err(PortcoveError::verification(
                "foreign pending acquisition owner marker",
            ));
        }
    }
    // No archive write starts until the complete owner has been atomically published.
    if !has_owner
        && members
            .iter()
            .any(|member| member.file_name() != "owner.pending")
    {
        return Err(PortcoveError::verification(
            "archive acquisition has no complete owner marker; retained for review",
        ));
    }
    for member in members {
        let metadata = fs::symlink_metadata(member.path())?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || (member.file_name() != "owner.json"
                && member.file_name() != "owner.pending"
                && !(0..payload.assets.len()).any(|index| member.path() == file(&private, index)))
        {
            return Err(PortcoveError::verification(
                "foreign or linked acquisition member; retained for review",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "game_update_acquisition_tests.rs"]
mod tests;
