//! Immutable update bytes. This journal never owns installed runtime or player data.
use super::*;
use crate::operation::acquisition::{AcquisitionJournal, AcquisitionOperation, root};
#[cfg(test)]
use crate::operation::acquisition::{
    MAX_BYTES, MAX_RECORD_BYTES, MAX_RECORDS, require_capacity, validate_journal,
};
use crate::{GameUpdateAcquisition, GameUpdateAcquisitionPhase as Phase};
#[cfg(test)]
use rusqlite::Connection;
use std::{
    fs::OpenOptions,
    io::{Read, Write},
};

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
                let mut record = AcquisitionOperation::reserve(&self.library, AcquisitionJournal {
                    view,
                    definition_sha256: definition_digest(self.catalog.port(port_id)?)?,
                    assets: assets_for(&reviewed.plan),
                })?;
                record.persist(&store)?;
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
            let reserved = record.payload()
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
            record.advance(Phase::Verifying, None, &store)?;
            let payload = record.payload();
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
            record.advance(Phase::Acquired, None, &store)?;
            Ok(record.payload().view.clone())
        }
        .await;
        if result.is_err()
            && let Some(record) = journal.as_mut()
            && let Err(error) = record.advance(
                Phase::AttentionRequired,
                result.as_ref().err().map(ToString::to_string),
                &store,
            )
        {
            tracing::warn!(%error,"unable to record acquisition attention state; retained journal remains recoverable");
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
        let record = AcquisitionOperation::decode(&self.library, record)?;
        if record.port_id() != view.port_id {
            return Err(PortcoveError::conflict(
                "acquisition owner changed; review again",
            ));
        }
        let payload = record.payload();
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
        let record = AcquisitionOperation::decode(&self.library, record)?;
        if record.port_id() != view.port_id {
            return Err(PortcoveError::conflict(
                "acquisition owner changed; review again",
            ));
        }
        let payload = record.payload();
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
        let record = AcquisitionOperation::decode(&self.library, record)?;
        if record.port_id() != port_id {
            return Err(PortcoveError::verification(
                "acquisition belongs to another resource",
            ));
        }
        validate_private_files(&self.library, &record)?;
        let private = root(&self.library, acquisition_id)?;
        if private.exists() {
            let payload = record.payload();
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
        candidate: &AcquisitionOperation,
    ) -> Result<()> {
        let _owner = match self.library.try_lock_activity(candidate.id()) {
            Ok(guard) => guard,
            Err(error) if error.code == crate::ErrorCode::Conflict => return Ok(()),
            Err(error) => return Err(error),
        };
        let Some(current) = store.get(candidate.id())? else {
            return Ok(());
        };
        if current.created_at != candidate.created_at()
            || current.kind != LifecycleOperationKind::AcquireUpdate
            || current.port_id != candidate.port_id()
        {
            return Ok(());
        }
        let mut current = AcquisitionOperation::decode(&self.library, current)?;
        let payload = current.payload();
        if payload.view.phase == Phase::Acquired || payload.view.phase == Phase::AttentionRequired {
            let status = if payload.view.phase == Phase::Acquired {
                ActivityStatus::Succeeded
            } else {
                ActivityStatus::Failed
            };
            finish_if_running(
                &self.library,
                current.id(),
                status,
                current.last_error().unwrap_or(
                    "Archive download completed; a fresh review is required before preparation",
                ),
            )?;
            return Ok(());
        }
        current.advance(Phase::AttentionRequired, Some("Archive acquisition was interrupted. Discard this exact private archive and review a new download; no runtime was prepared or activated.".into()), store)?;
        finish_if_running(
            &self.library,
            current.id(),
            ActivityStatus::Failed,
            current
                .last_error()
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

fn validate_private_files(library: &Library, record: &AcquisitionOperation) -> Result<()> {
    let private = root(library, record.id())?;
    if !private.try_exists()? {
        return Ok(());
    }
    let metadata = fs::symlink_metadata(&private)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(PortcoveError::verification(
            "acquisition root is not an owned directory",
        ));
    }
    let payload = record.payload();
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
    let expected = serde_json::to_vec(&(record.id(), record.port_id()))?;
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
