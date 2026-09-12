//! Reviewed, recoverable source import into the profile-scoped Source Inbox.

use std::{
    collections::VecDeque,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    ActivityOperation, ActivityStatus, ActivityTargetKind, DestructiveAuthorization,
    OperationCoordinator, OperationEvent, OperationResult, PortcoveError, PortcoveService, Result,
    SourceAdmission, SourceAdmissionMode, SourceComponentKind, SourceDiscoveryLimits, SourceRecord,
    operation::{LifecycleOperation, LifecycleOperationKind, LifecyclePhase, OperationStore},
};

const IMPORT_PLAN_SCHEMA_VERSION: u32 = 1;
const PUBLICATION_RECEIPT_SCHEMA_VERSION: u32 = 1;
const PUBLICATION_RECEIPT_FILE: &str = ".portcove-publication-receipt.json";
const MAX_IMPORT_ENTRIES: u32 = 4_096;
const MOVE_ACTION: &str = "move_source_to_inbox";

#[cfg(test)]
#[path = "source_import_tests.rs"]
mod tests;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SourceImportMode {
    Copy,
    Move,
    UseCurrentLocation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SourceImportOutcome {
    Copied,
    Moved,
    ReusedExisting,
    RegisteredCurrentLocation,
    CopiedOriginalRetained,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SourceImportPlan {
    pub schema_version: u32,
    pub profile_id: String,
    pub mode: SourceImportMode,
    pub source: SourceRecord,
    pub admission_mode: SourceAdmissionMode,
    pub destination: PathBuf,
    pub destination_exists: bool,
    pub reuse_existing: bool,
    pub required_bytes: u64,
    pub existing_registration: Option<SourceRecord>,
    /// Binds the reviewed path to its filesystem objects as well as its bytes.
    pub source_guard_sha256: String,
    pub plan_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SourceImportResult {
    pub import_id: String,
    pub profile_id: String,
    pub mode: SourceImportMode,
    pub outcome: SourceImportOutcome,
    pub registered: SourceRecord,
    pub copied: bool,
    pub original_deleted: bool,
    pub original_retained: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retained_original_path: Option<PathBuf>,
    pub recovered: bool,
}

#[derive(Debug, Clone, Serialize)]
struct GuardEntry {
    relative_path: String,
    kind: GuardKind,
    size: u64,
    object_identity: String,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum GuardKind {
    File,
    Directory,
}

struct SourceGuard {
    sha256: String,
    bytes: u64,
    root_identity: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SourceImportPublicationReceipt {
    schema_version: u32,
    import_id: String,
    plan_sha256: String,
    destination: PathBuf,
    object_identity: String,
}

impl PortcoveService {
    /// Inspect and bind an import without creating directories, copying, registering, or deleting.
    pub fn plan_source_import(
        &self,
        profile_id: &str,
        path: &Path,
        mode: SourceImportMode,
    ) -> Result<SourceImportPlan> {
        self.catalog().source_profile(profile_id)?;
        let source_path = canonical_source(path)?;
        if mode != SourceImportMode::UseCurrentLocation {
            let inbox_root = fs::canonicalize(self.library().source_inbox_dir())?;
            if source_path.starts_with(&inbox_root) {
                return Err(PortcoveError::conflict(
                    "a Source Inbox path cannot be copied or moved as another Inbox import; use its current location",
                )
                .detail("profile_id", profile_id));
            }
            if inbox_root.starts_with(&source_path) {
                return Err(PortcoveError::conflict(
                    "the selected source contains the Source Inbox destination",
                )
                .detail("profile_id", profile_id));
            }
        }
        let guard = source_guard(&source_path)?;
        let inspection = self.inspect_source(profile_id, &source_path)?;
        let admission_mode = match inspection.assessment.admission {
            SourceAdmission::Admitted { mode } => mode,
            _ => return Err(inspection.require_admitted_record().unwrap_err()),
        };
        let source = inspection.require_admitted_record()?;
        let existing_registration = self.library().source(profile_id)?;

        let (destination, destination_exists, reuse_existing, required_bytes) = match mode {
            SourceImportMode::UseCurrentLocation => (source_path.clone(), true, true, 0),
            SourceImportMode::Copy | SourceImportMode::Move => {
                let profile_dir = self.library().source_inbox_profile_dir(profile_id)?;
                choose_destination(
                    self,
                    profile_id,
                    &source,
                    &source_path,
                    &guard,
                    &profile_dir,
                )?
            }
        };

        let mut plan = SourceImportPlan {
            schema_version: IMPORT_PLAN_SCHEMA_VERSION,
            profile_id: profile_id.into(),
            mode,
            source,
            admission_mode,
            destination,
            destination_exists,
            reuse_existing,
            required_bytes,
            existing_registration,
            source_guard_sha256: guard.sha256,
            plan_sha256: String::new(),
        };
        plan.plan_sha256 = plan_fingerprint(&plan)?;
        Ok(plan)
    }

    pub fn authorize_source_move(
        &self,
        profile_id: &str,
        path: &Path,
        expected_plan_sha256: &str,
    ) -> Result<DestructiveAuthorization> {
        let plan = self.plan_source_import(profile_id, path, SourceImportMode::Move)?;
        require_expected_plan(&plan, expected_plan_sha256)?;
        self.library().issue_authorization(
            MOVE_ACTION,
            &move_target(profile_id, &plan.source.path)?,
            &plan.plan_sha256,
        )
    }

    pub fn import_source(
        &self,
        profile_id: &str,
        path: &Path,
        mode: SourceImportMode,
        expected_plan_sha256: &str,
        move_authorization: Option<&str>,
    ) -> Result<SourceImportResult> {
        self.import_source_with_progress(
            profile_id,
            path,
            mode,
            expected_plan_sha256,
            move_authorization,
            |_| {},
        )
    }

    pub fn import_source_with_progress<F>(
        &self,
        profile_id: &str,
        path: &Path,
        mode: SourceImportMode,
        expected_plan_sha256: &str,
        move_authorization: Option<&str>,
        mut emit: F,
    ) -> Result<SourceImportResult>
    where
        F: FnMut(OperationEvent),
    {
        let (activity, coordinator) = self.begin_cancellable_activity(
            ActivityOperation::ImportSource,
            ActivityTargetKind::Source,
            Some(profile_id),
        )?;
        emit(coordinator.started());
        let store = OperationStore::new(self.library().clone());
        let result = (|| {
            let _guards = self.lock_source_dependents(profile_id, None)?;
            let plan = self.plan_source_import(profile_id, path, mode)?;
            require_expected_plan(&plan, expected_plan_sha256)?;
            if mode == SourceImportMode::Move {
                let token = move_authorization.ok_or_else(|| {
                    PortcoveError::conflict(
                        "moving an original source requires a reviewed destructive authorization",
                    )
                })?;
                self.library().consume_authorization(
                    token,
                    MOVE_ACTION,
                    &move_target(profile_id, &plan.source.path)?,
                    &plan.plan_sha256,
                )?;
            } else if move_authorization.is_some() {
                return Err(PortcoveError::usage(
                    "a move authorization can only be used with move mode",
                ));
            }

            if mode == SourceImportMode::UseCurrentLocation {
                let registered = revalidate_source(self, &plan, &plan.source.path)?;
                self.library().register_source(&registered)?;
                return Ok(SourceImportResult {
                    import_id: activity.id.clone(),
                    profile_id: profile_id.into(),
                    mode,
                    outcome: SourceImportOutcome::RegisteredCurrentLocation,
                    registered,
                    copied: false,
                    original_deleted: false,
                    original_retained: true,
                    retained_original_path: Some(plan.source.path.clone()),
                    recovered: false,
                });
            }

            ensure_profile_directory(self, profile_id)?;
            require_capacity(&plan.destination, plan.required_bytes)?;
            let staging_root = plan
                .destination
                .parent()
                .ok_or_else(|| {
                    PortcoveError::state("Source Inbox destination has no profile directory")
                })?
                .join(format!(".portcove-import-{}.staging", activity.id));
            let filename = plan
                .destination
                .file_name()
                .ok_or_else(|| PortcoveError::state("Source Inbox destination has no filename"))?;
            let staging = staging_root.join(filename);
            let mut operation = LifecycleOperation::new(
                &activity.id,
                LifecycleOperationKind::ImportSource,
                profile_id,
            );
            operation.paths.staging = Some(staging);
            operation.paths.final_path = Some(plan.destination.clone());
            operation.original_paths = vec![plan.source.path.clone()];
            operation.source_import = Some(plan);
            store.put(&mut operation)?;
            self.check_lifecycle_fault(
                crate::operation::LifecycleFaultPoint::SourceImportJournaled,
            )?;
            continue_import(self, &store, &mut operation, &coordinator, &mut emit, false)
        })();

        match result {
            Ok(result) => {
                self.library().finish_activity(
                    &activity.id,
                    ActivityStatus::Succeeded,
                    Some(import_message(result.outcome)),
                )?;
                emit(coordinator.finished(OperationResult::Succeeded));
                Ok(result)
            }
            Err(error) if error.code == crate::ErrorCode::Cancelled => {
                cleanup_cancelled_import(&store, &activity.id)?;
                let result = self.finish_activity(activity, Err(error));
                emit(coordinator.finished(OperationResult::from_result(&result)));
                result
            }
            Err(error) => {
                if store
                    .all()?
                    .iter()
                    .any(|operation| operation.id == activity.id)
                {
                    emit(
                        coordinator
                            .message("error", "Source import paused in a recoverable state."),
                    );
                    Err(error.detail("import_id", &activity.id).detail(
                        "recovery_action",
                        "restart Portcove to resume source import",
                    ))
                } else {
                    let result = self.finish_activity(activity, Err(error));
                    emit(coordinator.finished(OperationResult::from_result(&result)));
                    result
                }
            }
        }
    }
}

pub(crate) fn recover(
    service: &PortcoveService,
    store: &OperationStore,
    operation: &mut LifecycleOperation,
) -> Result<SourceImportResult> {
    let profile_id = operation.port_id.clone();
    let coordinator = OperationCoordinator::resume(
        &operation.id,
        ActivityOperation::ImportSource.to_string(),
        Some(crate::OperationTarget {
            kind: ActivityTargetKind::Source,
            id: profile_id,
        }),
    );
    continue_import(service, store, operation, &coordinator, &mut |_| {}, true)
}

fn continue_import<F>(
    service: &PortcoveService,
    store: &OperationStore,
    operation: &mut LifecycleOperation,
    coordinator: &OperationCoordinator,
    emit: &mut F,
    recovered: bool,
) -> Result<SourceImportResult>
where
    F: FnMut(OperationEvent),
{
    let plan = operation
        .source_import
        .clone()
        .ok_or_else(|| PortcoveError::state("source import lifecycle record has no bound plan"))?;
    if plan.schema_version != IMPORT_PLAN_SCHEMA_VERSION || plan.profile_id != operation.port_id {
        return Err(PortcoveError::state(
            "source import lifecycle record has an incompatible plan",
        ));
    }
    let final_path =
        operation.paths.final_path.as_ref().ok_or_else(|| {
            PortcoveError::state("source import lifecycle record has no destination")
        })?;
    if final_path != &plan.destination {
        return Err(PortcoveError::verification(
            "source import destination no longer matches its reviewed plan",
        ));
    }

    if operation.phase == LifecyclePhase::Preparing {
        revalidate_source(service, &plan, &plan.source.path)?;
        ensure_profile_directory(service, &plan.profile_id)?;
        require_capacity(&plan.destination, plan.required_bytes)?;
        if plan.reuse_existing {
            revalidate_destination(service, &plan)?;
        } else {
            let staging = operation.paths.staging.as_ref().ok_or_else(|| {
                PortcoveError::state("source import lifecycle record has no staging path")
            })?;
            prepare_staging(staging, &plan.destination, &operation.id)?;
            service.check_lifecycle_fault(
                crate::operation::LifecycleFaultPoint::SourceImportCopyStarted,
            )?;
            emit(coordinator.progress("copy", 0, Some(plan.required_bytes)));
            copy_source(
                &plan.source.path,
                staging,
                coordinator,
                emit,
                plan.required_bytes,
            )?;
            service
                .check_lifecycle_fault(crate::operation::LifecycleFaultPoint::SourceImportCopied)?;
            revalidate_source(service, &plan, &plan.source.path)?;
            let staged = revalidate_source(service, &plan, staging)?;
            require_equivalent(&plan.source, &staged, "staged source")?;
        }
        operation.phase = LifecyclePhase::Prepared;
        operation.last_error = None;
        store.put(operation)?;
        service
            .check_lifecycle_fault(crate::operation::LifecycleFaultPoint::SourceImportVerified)?;
    }

    if operation.phase == LifecyclePhase::Prepared {
        if plan.reuse_existing {
            revalidate_source(service, &plan, &plan.source.path)?;
        } else {
            publish_staging(service, operation, &plan)?;
            service.check_lifecycle_fault(
                crate::operation::LifecycleFaultPoint::SourceImportBeforePublicationRecorded,
            )?;
        }
        revalidate_destination(service, &plan)?;
        if !plan.reuse_existing {
            service.check_lifecycle_fault(
                crate::operation::LifecycleFaultPoint::SourceImportBeforePublicationOwnershipRecorded,
            )?;
            verify_publication_receipt(operation, &plan, &plan.destination)?;
        }
        operation.phase = LifecyclePhase::PayloadPublished;
        store.put(operation)?;
        if !plan.reuse_existing {
            cleanup_publication_receipt(operation, &plan)?;
        }
        service
            .check_lifecycle_fault(crate::operation::LifecycleFaultPoint::SourceImportPublished)?;
    }

    if operation.phase == LifecyclePhase::PayloadPublished {
        if !plan.reuse_existing {
            cleanup_publication_receipt(operation, &plan)?;
        }
        let registered = revalidate_destination(service, &plan)?;
        service.library().register_source(&registered)?;
        operation.phase = LifecyclePhase::MetadataCommitted;
        store.put(operation)?;
        service
            .check_lifecycle_fault(crate::operation::LifecycleFaultPoint::SourceImportRegistered)?;
    }

    let registered = revalidate_registered(service, &plan)?;
    if plan.mode == SourceImportMode::Move {
        operation.phase = LifecyclePhase::CleanupPending;
        store.put(operation)?;
        let cleanup = cleanup_original(service, store, operation, &plan)?;
        service.check_lifecycle_fault(
            crate::operation::LifecycleFaultPoint::SourceImportCleanupCompleted,
        )?;
        if let Some(retained) = cleanup {
            store.remove(&operation.id)?;
            return Ok(SourceImportResult {
                import_id: operation.id.clone(),
                profile_id: plan.profile_id,
                mode: plan.mode,
                outcome: SourceImportOutcome::CopiedOriginalRetained,
                registered,
                copied: !plan.reuse_existing,
                original_deleted: false,
                original_retained: true,
                retained_original_path: Some(retained),
                recovered,
            });
        }
        store.remove(&operation.id)?;
        return Ok(SourceImportResult {
            import_id: operation.id.clone(),
            profile_id: plan.profile_id,
            mode: plan.mode,
            outcome: SourceImportOutcome::Moved,
            registered,
            copied: !plan.reuse_existing,
            original_deleted: true,
            original_retained: false,
            retained_original_path: None,
            recovered,
        });
    }

    store.remove(&operation.id)?;
    Ok(SourceImportResult {
        import_id: operation.id.clone(),
        profile_id: plan.profile_id,
        mode: plan.mode,
        outcome: if plan.reuse_existing {
            SourceImportOutcome::ReusedExisting
        } else {
            SourceImportOutcome::Copied
        },
        registered,
        copied: !plan.reuse_existing,
        original_deleted: false,
        original_retained: true,
        retained_original_path: Some(plan.source.path),
        recovered,
    })
}

fn choose_destination(
    service: &PortcoveService,
    profile_id: &str,
    source: &SourceRecord,
    source_path: &Path,
    guard: &SourceGuard,
    profile_dir: &Path,
) -> Result<(PathBuf, bool, bool, u64)> {
    let name = safe_import_name(source_path, &source.storage_sha256)?;
    let base = profile_dir.join(&name);
    if !base.try_exists()? {
        return Ok((base, false, false, guard.bytes));
    }
    require_regular_source_shape(&base)?;
    if object_identity(&base)? == guard.root_identity {
        return Err(PortcoveError::conflict(
            "source and Source Inbox destination identify the same filesystem object",
        ));
    }
    if destination_matches(service, profile_id, source, &base)? {
        return Ok((base, true, true, 0));
    }
    let suffixed = profile_dir.join(digest_name(&name, &source.storage_sha256));
    if !suffixed.try_exists()? {
        return Ok((suffixed, false, false, guard.bytes));
    }
    require_regular_source_shape(&suffixed)?;
    if object_identity(&suffixed)? == guard.root_identity {
        return Err(PortcoveError::conflict(
            "source and Source Inbox collision target identify the same filesystem object",
        ));
    }
    if destination_matches(service, profile_id, source, &suffixed)? {
        Ok((suffixed, true, true, 0))
    } else {
        Err(PortcoveError::conflict(
            "the deterministic Source Inbox collision path contains different bytes",
        )
        .detail("profile_id", profile_id)
        .detail("destination", suffixed.display().to_string()))
    }
}

fn destination_matches(
    service: &PortcoveService,
    profile_id: &str,
    source: &SourceRecord,
    destination: &Path,
) -> Result<bool> {
    match service.inspect_source(profile_id, destination) {
        Ok(inspection) => match inspection.require_admitted_record() {
            Ok(record) => Ok(equivalent(source, &record)),
            Err(_) => Ok(false),
        },
        Err(error) if error.code == crate::ErrorCode::SourceInvalid => Ok(false),
        Err(error) => Err(error),
    }
}

fn revalidate_source(
    service: &PortcoveService,
    plan: &SourceImportPlan,
    path: &Path,
) -> Result<SourceRecord> {
    if path == plan.source.path && source_guard(path)?.sha256 != plan.source_guard_sha256 {
        return Err(PortcoveError::conflict(
            "source filesystem identity changed after import review",
        )
        .detail("profile_id", &plan.profile_id));
    }
    let record = inspect_admitted_source(service, plan, path)?;
    require_equivalent(&plan.source, &record, "source")?;
    Ok(record)
}

fn inspect_admitted_source(
    service: &PortcoveService,
    plan: &SourceImportPlan,
    path: &Path,
) -> Result<SourceRecord> {
    let inspection = service.inspect_source(&plan.profile_id, path)?;
    let admission = match inspection.assessment.admission {
        SourceAdmission::Admitted { mode } => mode,
        _ => return Err(inspection.require_admitted_record().unwrap_err()),
    };
    if admission != plan.admission_mode {
        return Err(PortcoveError::conflict(
            "source admission changed after import review",
        ));
    }
    inspection.require_admitted_record()
}

fn revalidate_destination(
    service: &PortcoveService,
    plan: &SourceImportPlan,
) -> Result<SourceRecord> {
    let inspection = service.inspect_source(&plan.profile_id, &plan.destination)?;
    let record = inspection.require_admitted_record()?;
    require_equivalent(&plan.source, &record, "published Source Inbox source")?;
    Ok(record)
}

fn revalidate_registered(
    service: &PortcoveService,
    plan: &SourceImportPlan,
) -> Result<SourceRecord> {
    let registered = service
        .library()
        .source(&plan.profile_id)?
        .ok_or_else(|| PortcoveError::state("published source import is not registered"))?;
    if registered.path != plan.destination || !equivalent(&plan.source, &registered) {
        return Err(PortcoveError::conflict(
            "source registration changed after import publication",
        ));
    }
    service.verify_source_record(&registered)?;
    Ok(registered)
}

fn publish_staging(
    service: &PortcoveService,
    operation: &LifecycleOperation,
    plan: &SourceImportPlan,
) -> Result<()> {
    let staging = operation.paths.staging.as_ref().ok_or_else(|| {
        PortcoveError::state("source import lifecycle record has no staging path")
    })?;
    let profile = plan
        .destination
        .parent()
        .ok_or_else(|| PortcoveError::state("Source Inbox destination has no parent"))?;
    let staging_root = validated_staging_root(staging, profile, &operation.id)?;
    let staging_exists = path_exists(staging)?;
    let destination_exists = path_exists(&plan.destination)?;
    match (staging_exists, destination_exists) {
        (true, false) => {
            require_owned_staging_root(staging_root, profile)?;
            require_regular_source_shape(staging)?;
            revalidate_source(service, plan, &plan.source.path)?;
            ensure_publication_receipt(operation, plan, staging)?;
            service.check_lifecycle_fault(
                crate::operation::LifecycleFaultPoint::SourceImportPublicationPrepared,
            )?;
            crate::durability::rename_noreplace(staging, &plan.destination)?;
            crate::durability::sync_publication(profile)?;
            verify_publication_receipt(operation, plan, &plan.destination)?;
        }
        (false, true) => {
            require_owned_staging_root(staging_root, profile)?;
            require_regular_source_shape(&plan.destination)?;
            verify_publication_receipt(operation, plan, &plan.destination)?;
        }
        (true, true) => {
            return Err(PortcoveError::conflict(
                "both source import staging and its final destination exist",
            )
            .detail("staging", staging.display().to_string())
            .detail("destination", plan.destination.display().to_string()));
        }
        (false, false) => {
            return Err(PortcoveError::state(
                "prepared source import staging and destination are both absent",
            )
            .detail("staging", staging.display().to_string())
            .detail("destination", plan.destination.display().to_string()));
        }
    }
    Ok(())
}

fn path_exists(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn ensure_publication_receipt(
    operation: &LifecycleOperation,
    plan: &SourceImportPlan,
    staged: &Path,
) -> Result<()> {
    let receipt_path = publication_receipt_path(operation, plan)?;
    let expected = SourceImportPublicationReceipt {
        schema_version: PUBLICATION_RECEIPT_SCHEMA_VERSION,
        import_id: operation.id.clone(),
        plan_sha256: plan.plan_sha256.clone(),
        destination: plan.destination.clone(),
        object_identity: object_identity(staged)?,
    };
    if path_exists(&receipt_path)? {
        let actual = read_publication_receipt(&receipt_path)?;
        require_publication_receipt(&actual, &expected)?;
    } else {
        crate::durability::write_json_atomically(&receipt_path, &expected, false)?;
    }
    Ok(())
}

fn verify_publication_receipt(
    operation: &LifecycleOperation,
    plan: &SourceImportPlan,
    published: &Path,
) -> Result<()> {
    let receipt_path = publication_receipt_path(operation, plan)?;
    let actual = read_publication_receipt(&receipt_path)?;
    let expected = SourceImportPublicationReceipt {
        schema_version: PUBLICATION_RECEIPT_SCHEMA_VERSION,
        import_id: operation.id.clone(),
        plan_sha256: plan.plan_sha256.clone(),
        destination: plan.destination.clone(),
        object_identity: object_identity(published)?,
    };
    require_publication_receipt(&actual, &expected)
}

fn require_publication_receipt(
    actual: &SourceImportPublicationReceipt,
    expected: &SourceImportPublicationReceipt,
) -> Result<()> {
    if actual.schema_version != PUBLICATION_RECEIPT_SCHEMA_VERSION
        || uuid::Uuid::parse_str(&actual.import_id).is_err()
        || actual.import_id != expected.import_id
        || actual.plan_sha256 != expected.plan_sha256
        || actual.destination != expected.destination
        || actual.object_identity != expected.object_identity
    {
        return Err(PortcoveError::conflict(
            "source import publication receipt does not own the observed destination",
        ));
    }
    Ok(())
}

fn read_publication_receipt(path: &Path) -> Result<SourceImportPublicationReceipt> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            PortcoveError::conflict(
                "source import destination exists without its operation-bound publication receipt",
            )
        } else {
            error.into()
        }
    })?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 16 * 1024 {
        return Err(PortcoveError::state(
            "source import publication receipt is not a bounded regular file",
        ));
    }
    Ok(serde_json::from_slice(&crate::path::read_bounded_regular(
        path,
        16 * 1024,
    )?)?)
}

fn publication_receipt_path(
    operation: &LifecycleOperation,
    plan: &SourceImportPlan,
) -> Result<PathBuf> {
    let staging = operation.paths.staging.as_ref().ok_or_else(|| {
        PortcoveError::state("source import lifecycle record has no staging path")
    })?;
    let profile = plan
        .destination
        .parent()
        .ok_or_else(|| PortcoveError::state("Source Inbox destination has no parent"))?;
    Ok(validated_staging_root(staging, profile, &operation.id)?.join(PUBLICATION_RECEIPT_FILE))
}

fn cleanup_publication_receipt(
    operation: &LifecycleOperation,
    plan: &SourceImportPlan,
) -> Result<()> {
    let receipt = publication_receipt_path(operation, plan)?;
    let root = receipt
        .parent()
        .ok_or_else(|| PortcoveError::state("source import receipt path has no parent"))?;
    if !path_exists(root)? {
        return Ok(());
    }
    let profile = plan
        .destination
        .parent()
        .ok_or_else(|| PortcoveError::state("Source Inbox destination has no parent"))?;
    require_owned_staging_root(root, profile)?;
    match fs::remove_file(&receipt) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    match fs::remove_dir(root) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

fn cleanup_original(
    service: &PortcoveService,
    store: &OperationStore,
    operation: &mut LifecycleOperation,
    plan: &SourceImportPlan,
) -> Result<Option<PathBuf>> {
    let source = &plan.source.path;
    let quarantine = operation
        .paths
        .quarantine
        .clone()
        .unwrap_or_else(|| quarantine_path(source, &operation.id));
    operation.paths.quarantine = Some(quarantine.clone());
    store.put(operation)?;

    let source_exists = source.try_exists()?;
    let quarantine_exists = quarantine.try_exists()?;
    if source_exists && quarantine_exists {
        // The old path now names an unreviewed replacement. Preserve both and
        // report the quarantined reviewed original as the cleanup remainder.
        return Ok(Some(quarantine));
    }
    if source_exists {
        if let Err(error) = revalidate_source(service, plan, source) {
            operation.last_error = Some(error.message);
            store.put(operation)?;
            return Ok(Some(source.clone()));
        }
        if let Err(error) = crate::durability::rename_noreplace(source, &quarantine) {
            operation.last_error = Some(error.to_string());
            store.put(operation)?;
            return Ok(Some(source.clone()));
        }
        service.check_lifecycle_fault(
            crate::operation::LifecycleFaultPoint::SourceImportOriginalQuarantined,
        )?;
    }
    if !quarantine.try_exists()? {
        return Ok(None);
    }
    let guard_matches = source_guard(&quarantine)?.sha256 == plan.source_guard_sha256;
    let identity_matches = guard_matches
        && inspect_admitted_source(service, plan, &quarantine)
            .is_ok_and(|record| cleanup_source_equivalent(&quarantine, &plan.source, &record));
    if !identity_matches {
        return Ok(Some(quarantine));
    }
    if let Err(error) = service
        .check_lifecycle_fault(crate::operation::LifecycleFaultPoint::SourceImportDeleteAttempt)
    {
        operation.last_error = Some(error.message);
        store.put(operation)?;
        return Ok(Some(quarantine));
    }
    let deletion = if fs::symlink_metadata(&quarantine)?.is_dir() {
        fs::remove_dir_all(&quarantine)
    } else {
        fs::remove_file(&quarantine)
    };
    if let Err(error) = deletion {
        operation.last_error = Some(error.to_string());
        store.put(operation)?;
        return Ok(Some(quarantine));
    }
    Ok(None)
}

fn quarantine_path(source: &Path, operation_id: &str) -> PathBuf {
    let suffix = source
        .extension()
        .and_then(|extension| extension.to_str())
        .filter(|extension| !extension.is_empty())
        .map(|extension| format!(".{extension}"))
        .unwrap_or_default();
    source
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(format!(
            ".portcove-source-import-{operation_id}.retained{suffix}"
        ))
}

fn prepare_staging(staging: &Path, destination: &Path, import_id: &str) -> Result<()> {
    let profile = destination
        .parent()
        .ok_or_else(|| PortcoveError::state("Source Inbox destination has no parent"))?;
    let staging_root = validated_staging_root(staging, profile, import_id)?;
    if staging_root.try_exists()? {
        require_owned_staging_tree(staging_root, profile)?;
        fs::remove_dir_all(staging_root)?;
    }
    fs::create_dir(staging_root)?;
    Ok(())
}

fn validated_staging_root<'a>(
    staging: &'a Path,
    profile: &Path,
    import_id: &str,
) -> Result<&'a Path> {
    let staging_root = staging
        .parent()
        .ok_or_else(|| PortcoveError::state("source import staging path has no parent"))?;
    if staging_root.parent() != Some(profile)
        || staging_root.file_name().and_then(|name| name.to_str())
            != Some(format!(".portcove-import-{import_id}.staging").as_str())
    {
        return Err(PortcoveError::verification(
            "source import staging path escaped its profile directory",
        ));
    }
    Ok(staging_root)
}

fn require_owned_staging_tree(staging_root: &Path, profile: &Path) -> Result<()> {
    require_owned_staging_root(staging_root, profile)?;
    source_guard(staging_root)?;
    Ok(())
}

fn require_owned_staging_root(staging_root: &Path, profile: &Path) -> Result<()> {
    crate::path::refuse_symlink_ancestors(staging_root)?;
    let canonical_profile = fs::canonicalize(profile)?;
    let canonical_staging = fs::canonicalize(staging_root)?;
    if !canonical_staging.starts_with(&canonical_profile)
        || fs::symlink_metadata(staging_root)?.file_type().is_symlink()
    {
        return Err(PortcoveError::verification(
            "source import staging tree is not an owned profile child",
        ));
    }
    Ok(())
}

fn copy_source<F>(
    source: &Path,
    destination: &Path,
    coordinator: &OperationCoordinator,
    emit: &mut F,
    total: u64,
) -> Result<()>
where
    F: FnMut(OperationEvent),
{
    let metadata = fs::symlink_metadata(source)?;
    if metadata.is_file() {
        return copy_file(source, destination, coordinator, emit, 0, total).map(|_| ());
    }
    fs::create_dir(destination)?;
    let mut copied = 0_u64;
    let mut pending = VecDeque::from([(source.to_path_buf(), destination.to_path_buf())]);
    while let Some((from, to)) = pending.pop_front() {
        coordinator.checkpoint()?;
        let mut entries = fs::read_dir(&from)?.collect::<std::io::Result<Vec<_>>>()?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            coordinator.checkpoint()?;
            let kind = entry.file_type()?;
            if kind.is_symlink() || (!kind.is_file() && !kind.is_dir()) {
                return Err(PortcoveError::verification(
                    "source changed to a link or special file while copying",
                ));
            }
            let target = to.join(entry.file_name());
            if kind.is_dir() {
                fs::create_dir(&target)?;
                pending.push_back((entry.path(), target));
            } else {
                copied = copy_file(&entry.path(), &target, coordinator, emit, copied, total)?;
            }
        }
        fs::set_permissions(&to, fs::metadata(&from)?.permissions())?;
    }
    Ok(())
}

fn copy_file<F>(
    source: &Path,
    destination: &Path,
    coordinator: &OperationCoordinator,
    emit: &mut F,
    mut copied: u64,
    total: u64,
) -> Result<u64>
where
    F: FnMut(OperationEvent),
{
    let mut input = File::open(source)?;
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(destination)?;
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        coordinator.checkpoint()?;
        let read = input.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        output.write_all(&buffer[..read])?;
        copied = copied.saturating_add(read as u64);
        emit(coordinator.progress("copy", copied, Some(total)));
    }
    output.sync_all()?;
    fs::set_permissions(destination, fs::metadata(source)?.permissions())?;
    Ok(copied)
}

fn source_guard(path: &Path) -> Result<SourceGuard> {
    crate::path::refuse_symlink_ancestors(path)?;
    let limits = SourceDiscoveryLimits::default();
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || (!metadata.is_file() && !metadata.is_dir()) {
        return Err(PortcoveError::source(
            "source import accepts only real files or directories",
        ));
    }
    let root_identity = object_identity(path)?;
    let mut entries = Vec::new();
    let mut total = 0_u64;
    let root_kind = if metadata.is_dir() {
        GuardKind::Directory
    } else {
        GuardKind::File
    };
    entries.push(GuardEntry {
        relative_path: String::new(),
        kind: root_kind,
        size: metadata.len(),
        object_identity: root_identity.clone(),
    });
    if metadata.is_file() {
        require_guard_file_size(metadata.len(), &limits)?;
        total = metadata.len();
    } else {
        let mut pending = VecDeque::from([path.to_path_buf()]);
        while let Some(directory) = pending.pop_front() {
            let mut children = fs::read_dir(&directory)?.collect::<std::io::Result<Vec<_>>>()?;
            children.sort_by_key(|entry| entry.file_name());
            for child in children {
                if entries.len() >= MAX_IMPORT_ENTRIES as usize {
                    return Err(PortcoveError::source(
                        "source import exceeds its entry limit",
                    ));
                }
                let kind = child.file_type()?;
                if kind.is_symlink() || (!kind.is_file() && !kind.is_dir()) {
                    return Err(PortcoveError::source(
                        "source import contains a link or special file",
                    ));
                }
                let child_path = child.path();
                let relative = child_path.strip_prefix(path).map_err(|_| {
                    PortcoveError::verification("source import path escaped its selected root")
                })?;
                let relative_path = relative
                    .components()
                    .map(|component| {
                        component.as_os_str().to_str().ok_or_else(|| {
                            PortcoveError::source("source import filenames must be Unicode")
                        })
                    })
                    .collect::<Result<Vec<_>>>()?
                    .join("/");
                let child_metadata = fs::symlink_metadata(&child_path)?;
                let entry_kind = if kind.is_dir() {
                    GuardKind::Directory
                } else {
                    require_guard_file_size(child_metadata.len(), &limits)?;
                    total = total
                        .checked_add(child_metadata.len())
                        .ok_or_else(|| PortcoveError::source("source import size overflowed"))?;
                    GuardKind::File
                };
                if total > limits.max_hash_bytes {
                    return Err(PortcoveError::source(
                        "source import exceeds its total byte limit",
                    ));
                }
                entries.push(GuardEntry {
                    relative_path,
                    kind: entry_kind,
                    size: child_metadata.len(),
                    object_identity: object_identity(&child_path)?,
                });
                if kind.is_dir() {
                    pending.push_back(child_path);
                }
            }
        }
    }
    Ok(SourceGuard {
        sha256: hex::encode(Sha256::digest(serde_json::to_vec(&entries)?)),
        bytes: total,
        root_identity,
    })
}

fn require_guard_file_size(size: u64, limits: &SourceDiscoveryLimits) -> Result<()> {
    if size == 0 || size > limits.max_file_bytes {
        return Err(PortcoveError::source(
            "source import contains an empty or oversized file",
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn object_identity(path: &Path) -> Result<String> {
    use std::os::unix::fs::MetadataExt;
    let metadata = fs::symlink_metadata(path)?;
    Ok(format!(
        "unix:{}:{}:{}:{}:{}:{}",
        metadata.dev(),
        metadata.ino(),
        metadata.mtime(),
        metadata.mtime_nsec(),
        metadata.len(),
        metadata.mode()
    ))
}

#[cfg(windows)]
fn object_identity(path: &Path) -> Result<String> {
    use std::{
        mem::zeroed,
        os::windows::{
            fs::{MetadataExt, OpenOptionsExt},
            io::AsRawHandle,
        },
    };
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS, FILE_READ_ATTRIBUTES,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, GetFileInformationByHandle,
    };

    let file = OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)?;
    // SAFETY: `information` is initialized for the Win32 output structure and
    // the borrowed handle remains valid for the duration of the call.
    let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { zeroed() };
    let succeeded =
        unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut information) };
    if succeeded == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let metadata = fs::symlink_metadata(path)?;
    Ok(format!(
        "windows:{}:{}:{}:{}:{}:{}:{}",
        information.dwVolumeSerialNumber,
        information.nFileIndexHigh,
        information.nFileIndexLow,
        information.nNumberOfLinks,
        metadata.last_write_time(),
        metadata.file_size(),
        metadata.file_attributes()
    ))
}

fn canonical_source(path: &Path) -> Result<PathBuf> {
    crate::path::unicode(path, "source import")?;
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() {
        return Err(PortcoveError::source(
            "source import refuses a symbolic link or junction",
        ));
    }
    let canonical = fs::canonicalize(path)?;
    crate::path::refuse_symlink_ancestors(&canonical)?;
    Ok(canonical)
}

fn require_regular_source_shape(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || (!metadata.is_file() && !metadata.is_dir()) {
        return Err(PortcoveError::conflict(
            "Source Inbox collision is a link or special file",
        ));
    }
    Ok(())
}

fn safe_import_name(source: &Path, storage_sha256: &str) -> Result<String> {
    let original = source
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| PortcoveError::source("source import filename must be Unicode"))?;
    let valid = crate::archive::validate_relative_path(original, true)
        .is_ok_and(|(path, key)| path.components().count() == 1 && key == original);
    if valid && !original.starts_with(".portcove-") {
        return Ok(original.into());
    }
    let suffix = storage_sha256.get(..12).unwrap_or(storage_sha256);
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 12
                && value.bytes().all(|byte| byte.is_ascii_alphanumeric())
        });
    Ok(match extension {
        Some(extension) => format!("source-{suffix}.{}", extension.to_ascii_lowercase()),
        None => format!("source-{suffix}"),
    })
}

fn digest_name(name: &str, storage_sha256: &str) -> String {
    let suffix = storage_sha256.get(..12).unwrap_or(storage_sha256);
    let path = Path::new(name);
    match (
        path.file_stem().and_then(|value| value.to_str()),
        path.extension().and_then(|value| value.to_str()),
    ) {
        (Some(stem), Some(extension)) if !stem.is_empty() => {
            format!("{stem}-{suffix}.{extension}")
        }
        _ => format!("{name}-{suffix}"),
    }
}

fn ensure_profile_directory(service: &PortcoveService, profile_id: &str) -> Result<PathBuf> {
    service
        .prepare_source_inbox_profile(profile_id)?
        .profile
        .ok_or_else(|| PortcoveError::state("prepared Source Inbox has no profile path"))
}

fn require_capacity(destination: &Path, required: u64) -> Result<()> {
    if required == 0 {
        return Ok(());
    }
    let parent = destination
        .parent()
        .ok_or_else(|| PortcoveError::state("Source Inbox destination has no parent"))?;
    let available = fs2::available_space(parent)?;
    if available < required {
        return Err(PortcoveError::conflict(
            "Source Inbox destination does not have enough free space",
        )
        .detail("required_bytes", required.to_string())
        .detail("available_bytes", available.to_string()));
    }
    Ok(())
}

fn plan_fingerprint(plan: &SourceImportPlan) -> Result<String> {
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(&(
        plan.schema_version,
        &plan.profile_id,
        plan.mode,
        source_fingerprint(&plan.source),
        plan.admission_mode,
        &plan.destination,
        plan.destination_exists,
        plan.reuse_existing,
        plan.required_bytes,
        plan.existing_registration.as_ref().map(source_fingerprint),
        &plan.source_guard_sha256,
    ))?)))
}

fn source_fingerprint(
    source: &SourceRecord,
) -> (
    &str,
    &Path,
    &str,
    u64,
    &str,
    u64,
    &Option<crate::ObservedSourceIdentity>,
) {
    (
        &source.profile_id,
        &source.path,
        &source.sha256,
        source.size,
        &source.storage_sha256,
        source.storage_size,
        &source.observed_identity,
    )
}

fn require_expected_plan(plan: &SourceImportPlan, expected: &str) -> Result<()> {
    if plan.plan_sha256 != expected {
        return Err(PortcoveError::conflict(
            "source, registration, or Source Inbox destination changed after import review",
        ));
    }
    Ok(())
}

fn move_target(profile_id: &str, source: &Path) -> Result<String> {
    Ok(format!(
        "{profile_id}:{}",
        crate::path::unicode(source, "source import")?
    ))
}

fn require_equivalent(expected: &SourceRecord, actual: &SourceRecord, label: &str) -> Result<()> {
    if !equivalent(expected, actual) {
        return Err(PortcoveError::verification(format!(
            "{label} does not match the reviewed source bytes"
        )));
    }
    Ok(())
}

fn equivalent(left: &SourceRecord, right: &SourceRecord) -> bool {
    left.profile_id == right.profile_id
        && left.sha256.eq_ignore_ascii_case(&right.sha256)
        && left.size == right.size
        && left
            .storage_sha256
            .eq_ignore_ascii_case(&right.storage_sha256)
        && left.storage_size == right.storage_size
        && left.observed_identity == right.observed_identity
}

fn cleanup_source_equivalent(
    quarantine: &Path,
    expected: &SourceRecord,
    actual: &SourceRecord,
) -> bool {
    if equivalent(expected, actual) {
        return true;
    }
    let Ok(metadata) = fs::symlink_metadata(quarantine) else {
        return false;
    };
    if !metadata.file_type().is_file() {
        return false;
    }
    let (Some(expected_identity), Some(actual_identity)) =
        (&expected.observed_identity, &actual.observed_identity)
    else {
        return false;
    };
    let ([expected_component], [actual_component]) = (
        expected_identity.components.as_slice(),
        actual_identity.components.as_slice(),
    ) else {
        return false;
    };
    if expected_component.kind != SourceComponentKind::OpticalDisc
        || actual_component.kind != SourceComponentKind::OpticalDisc
        || expected_component.name.is_none()
        || actual_component.name.is_none()
    {
        return false;
    }

    let mut normalized = actual.clone();
    normalized
        .observed_identity
        .as_mut()
        .expect("observed identity was checked above")
        .components[0]
        .name
        .clone_from(&expected_component.name);
    equivalent(expected, &normalized)
}

fn cleanup_cancelled_import(store: &OperationStore, id: &str) -> Result<()> {
    if let Some(operation) = store
        .all()?
        .into_iter()
        .find(|operation| operation.id == id)
        && operation.phase == LifecyclePhase::Preparing
    {
        if let Some(staging) = operation.paths.staging
            && let Some(root) = staging.parent()
            && root.try_exists()?
        {
            require_owned_staging_tree(
                root,
                operation
                    .paths
                    .final_path
                    .as_ref()
                    .and_then(|path| path.parent())
                    .ok_or_else(|| PortcoveError::state("import destination has no parent"))?,
            )?;
            fs::remove_dir_all(root)?;
        }
        store.remove(id)?;
    }
    Ok(())
}

pub(crate) fn import_message(outcome: SourceImportOutcome) -> &'static str {
    match outcome {
        SourceImportOutcome::Copied => "Source copied, verified, and registered",
        SourceImportOutcome::Moved => "Source copied, verified, registered, and original removed",
        SourceImportOutcome::ReusedExisting => {
            "Existing Source Inbox bytes verified and registered"
        }
        SourceImportOutcome::RegisteredCurrentLocation => {
            "Source verified and registered at its current location"
        }
        SourceImportOutcome::CopiedOriginalRetained => {
            "Source copied, verified, and registered; original retained"
        }
    }
}
