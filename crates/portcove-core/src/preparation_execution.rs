use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use rusqlite::OptionalExtension;

use super::{PreparationInputs, PreparationOptions, PreparationPlan, RECEIPT_FILE, tool_identity};
use crate::{
    ActivityOperation, ActivityTargetKind, AdoptionCopyPlan, ChildProcessClass,
    DestructiveAuthorization, InstallQualification, InstallRecord, Installer, MutationState,
    OperationCoordinator, OperationEvent, OperationResult, PortDefinition, PortcoveError,
    PortcoveService, PreparationCleanupPreview, RecoveryAction, Result,
    RuntimeSourceMaterialization,
    operation::{
        LifecycleFaultPoint, LifecycleOperation, LifecycleOperationKind, LifecyclePhase,
        OperationStore,
    },
};

#[derive(serde::Serialize, serde::Deserialize)]
pub(super) struct PreparationReceipt {
    pub(super) format_version: u32,
    pub(super) plan_sha256: String,
    pub(super) inputs: PreparationInputs,
}

// A GameCube disc image is at most 1,459,978,240 bytes. The pinned source
// validator records compressed containers by their stored size, so reserve a
// full image for materialization and another for generated setup output.
const GAMECUBE_DISC_CAPACITY_BYTES: u64 = 1_459_978_240;

fn preparation_capacity_bytes(
    copy_bytes: u64,
    stored_source_bytes: u64,
    materialization: Option<RuntimeSourceMaterialization>,
) -> Result<u64> {
    let (source_bytes, generated_bytes) =
        if materialization == Some(RuntimeSourceMaterialization::GamecubeIso) {
            (
                stored_source_bytes.max(GAMECUBE_DISC_CAPACITY_BYTES),
                GAMECUBE_DISC_CAPACITY_BYTES,
            )
        } else {
            (stored_source_bytes, 0)
        };
    copy_bytes
        .checked_add(source_bytes)
        .and_then(|bytes| bytes.checked_add(generated_bytes))
        .ok_or_else(|| PortcoveError::state("preparation capacity size overflowed"))
}

impl PortcoveService {
    /// Review the exact private preparation tree retained by an interrupted attempt.
    pub fn preview_preparation_cleanup(
        &self,
        operation_id: &str,
    ) -> Result<PreparationCleanupPreview> {
        let store = OperationStore::new(self.library().clone());
        let journal = private_preparation_journal(&store, operation_id)?;
        let _port_guard = self
            .library()
            .try_lock_port(&journal.port_id, "review-preparation-cleanup")?;
        let _activity_guard = self.library().try_lock_activity(operation_id)?;
        preparation_cleanup_preview(self, &private_preparation_journal(&store, operation_id)?)
    }

    pub fn authorize_preparation_cleanup(
        &self,
        operation_id: &str,
        expected_preview: &str,
    ) -> Result<DestructiveAuthorization> {
        validate_cleanup_fingerprint(expected_preview)?;
        let preview = self.preview_preparation_cleanup(operation_id)?;
        if preview.preview_sha256 != expected_preview {
            return Err(PortcoveError::conflict(
                "retained preparation changed; review cleanup again",
            )
            .with_mutation_state(MutationState::NoChanges)
            .during("preparation.cleanup.review"));
        }
        self.library()
            .issue_authorization("cleanup_preparation", operation_id, expected_preview)
    }

    /// Discard only a reviewed private preparation tree and its recovery journal.
    pub fn cleanup_preparation(
        &self,
        operation_id: &str,
        authorization: &str,
    ) -> Result<PreparationCleanupPreview> {
        let store = OperationStore::new(self.library().clone());
        let journal = private_preparation_journal(&store, operation_id)?;
        let _port_guard = self
            .library()
            .try_lock_port(&journal.port_id, "cleanup-preparation")?;
        let _activity_guard = self.library().try_lock_activity(operation_id)?;
        let mut journal = private_preparation_journal(&store, operation_id)?;
        let preview = preparation_cleanup_preview(self, &journal)?;
        self.library().consume_authorization_with_state(
            authorization,
            "cleanup_preparation",
            operation_id,
            || Ok(preview.preview_sha256.clone()),
        )?;
        journal.paths.quarantine = Some(cleanup_quarantine_path(
            &preview.retained_path,
            &journal.id,
            &preview.preview_sha256,
        )?);
        journal.phase = LifecyclePhase::CleanupPending;
        journal.last_error = None;
        store.put(&mut journal)?;
        if let Err(error) = remove_reviewed_private_preparation(self, &store, &mut journal) {
            journal.last_error = Some(error.message.clone());
            let _ = store.put(&mut journal);
            return Err(error
                .with_mutation_state(MutationState::RecoveryRequired)
                .during("preparation.cleanup"));
        }
        Ok(preview)
    }

    pub fn authorize_preparation(
        &self,
        port_id: &str,
        options: PreparationOptions,
        expected_plan: &str,
    ) -> Result<DestructiveAuthorization> {
        let plan = self.plan_preparation(port_id, options)?;
        if plan.plan_sha256 != expected_plan {
            return Err(PortcoveError::conflict(
                "preparation inputs changed; review the plan again",
            )
            .with_mutation_state(MutationState::NoChanges)
            .during("preparation.review"));
        }
        self.library()
            .issue_authorization("prepare", port_id, expected_plan)
    }

    /// Prepare an isolated derivative, then publish it through the existing journal.
    pub fn prepare(
        &self,
        port_id: &str,
        options: PreparationOptions,
        authorization: &str,
        mut emit: impl FnMut(OperationEvent),
    ) -> Result<InstallRecord> {
        let _guard = self.library().try_lock_port(port_id, "prepare")?;
        let plan = self
            .plan_preparation_locked(port_id, options)
            .map_err(|error| {
                error
                    .with_mutation_state(MutationState::NotStarted)
                    .during("preparation.review")
            })?;
        let port = self.installed_port(&plan.inputs.install)?;
        if !supports_single_source_setup_layout(&port) {
            return Err(PortcoveError::unsupported(
                "this preparation operation requires a reviewed single-source setup layout",
            ));
        }
        self.library().consume_authorization(
            authorization,
            "prepare",
            port_id,
            &plan.plan_sha256,
        )?;
        let (activity, operation) = self.begin_cancellable_activity(
            ActivityOperation::Prepare,
            ActivityTargetKind::Port,
            Some(port_id),
        )?;
        emit(operation.started());
        let mut result = self
            .prepare_derivative(&plan, &operation, &mut emit)
            .map_err(|error| error.offer_recovery(RecoveryAction::ReviewPreparation));
        if let Err(error) = &mut result {
            let store = OperationStore::new(self.library().clone());
            let recorded = (|| -> Result<()> {
                if let Some(mut journal) = store
                    .all()?
                    .into_iter()
                    .find(|entry| entry.id == activity.id)
                {
                    // Private work is retained on failure, including when a hard
                    // interruption leaves a tool's lifetime uncertain. A retry uses
                    // another operation ID; it never reuses or removes partial work.
                    error.failure.mutation_state = MutationState::RecoveryRequired;
                    journal.last_error = Some(error.message.clone());
                    store.put(&mut journal)?;
                }
                Ok(())
            })();
            if let Err(record_error) = recorded {
                tracing::error!(operation_id = activity.id, error = %record_error,
                    "could not record preparation failure; retaining the existing journal");
            }
        }
        let result = self.finish_activity(activity, result);
        emit(operation.finished(OperationResult::from_result(&result)));
        result
    }

    fn prepare_derivative(
        &self,
        plan: &PreparationPlan,
        operation: &OperationCoordinator,
        emit: &mut impl FnMut(OperationEvent),
    ) -> Result<InstallRecord> {
        let original = &plan.inputs.install;
        let root = original
            .path
            .parent()
            .ok_or_else(|| PortcoveError::state("installed preparation has no managed parent"))?;
        let port = self.installed_port(original)?;
        let required = preparation_capacity_bytes(
            plan.copy.total_bytes,
            plan.inputs.source.storage_size,
            port.runtime_source_materialization,
        )?;
        let prepared = crate::output_root::prepare_for_install(
            self.library(),
            &plan.port_id,
            root,
            operation.operation_id(),
            required,
        )?;
        let destination = prepared
            .root
            .join(crate::signed_catalog::digest(&serde_json::to_vec(&(
                "Portcove prepared derivative v1",
                &plan.plan_sha256,
                operation.operation_id(),
            ))?));
        let mut journal = LifecycleOperation::new(
            operation.operation_id(),
            LifecycleOperationKind::Prepare,
            &plan.port_id,
        );
        journal.paths.staging = Some(prepared.operation_root.clone());
        journal.paths.final_path = Some(destination.clone());
        journal.preparation = Some(plan.clone());
        // No child has started. This durable true state is replaced before
        // either admitted external preparation process can be spawned.
        journal.preparation_process_quiesced = Some(true);
        journal.activate = true;
        let store = OperationStore::new(self.library().clone());
        store.put(&mut journal)?;
        self.check_lifecycle_fault(LifecycleFaultPoint::PreparationJournaled)?;
        crate::path::refuse_symlink_ancestors(&prepared.operation_root)?;
        fs::create_dir_all(
            prepared
                .operation_root
                .parent()
                .ok_or_else(|| PortcoveError::state("preparation staging has no parent"))?,
        )?;
        // A new attempt must never reuse an existing private working directory.
        fs::create_dir(&prepared.operation_root)?;
        let payload = prepared.operation_root.join("payload");
        emit(operation.message(
            "info",
            "Copying the reviewed installation into private preparation",
        ));
        crate::transfer_copy::copy_reviewed_tree(
            &original.path,
            &payload,
            &plan.copy,
            &prepared.operation_root.join("copy-work"),
        )?;
        operation.checkpoint()?;
        crate::transfer_copy::verify_reviewed_tree(&payload, &plan.copy)?;
        self.check_lifecycle_fault(LifecycleFaultPoint::PreparationCopied)?;
        self.prepare_private_inputs(plan, &payload, operation, emit)
            .map_err(|error| error.detail("preparation_phase", "private inputs"))?;
        if self
            .plan_preparation_locked(&plan.port_id, plan.inputs.options)?
            .plan_sha256
            != plan.plan_sha256
        {
            return Err(PortcoveError::conflict(
                "preparation inputs changed during execution; private output was retained",
            ));
        }
        self.collect_active_user_data_if_launched(&plan.port_id)?;
        operation.checkpoint()?;
        let receipt = PreparationReceipt {
            format_version: 1,
            plan_sha256: plan.plan_sha256.clone(),
            inputs: plan.inputs.clone(),
        };
        crate::durability::write_bytes_atomically(
            &payload.join(RECEIPT_FILE),
            &serde_json::to_vec(&receipt)?,
            false,
        )?;
        let installer = Installer::new(self.library().clone())?;
        let retained = installer.retained_catalog(original)?;
        let qualification = InstallQualification::from_catalog(
            retained.as_ref().unwrap_or(self.catalog()),
            &plan.port_id,
            plan.inputs.host,
        )?;
        let mut install = installer
            .create_prepared_manifest(original, operation.operation_id(), &qualification, &payload)
            .map_err(|error| error.detail("preparation_phase", "create manifest"))?;
        installer
            .verify_critical(&install, &qualification)
            .map_err(|error| error.detail("preparation_phase", "verify critical"))?;
        if !installer.verify_managed(&install, &qualification)?.valid {
            return Err(PortcoveError::verification(
                "prepared output failed its immutable manifest check",
            ));
        }
        let port = self.installed_port(original)?;
        let setup_root =
            setup_output_root(&port, &payload, &payload.join(&install.selected_executable))?;
        crate::adapter::bind_upstream_setup_manifest(&setup_root, &install.manifest_sha256)
            .map_err(|error| error.detail("preparation_phase", "bind manifest"))?;
        self.check_lifecycle_fault(LifecycleFaultPoint::PreparationOutputsValidated)?;
        install.path = destination;
        journal.install = Some(install.clone());
        operation.begin_publication()?;
        journal.phase = LifecyclePhase::Prepared;
        store.put(&mut journal)?;
        self.check_lifecycle_fault(LifecycleFaultPoint::PreparationPrepared)?;
        emit(operation.message("info", "Publishing the verified prepared installation"));
        recover(self, &store, &mut journal)?;
        Ok(install)
    }

    fn prepare_private_inputs(
        &self,
        plan: &PreparationPlan,
        payload: &Path,
        operation: &OperationCoordinator,
        emit: &mut impl FnMut(OperationEvent),
    ) -> Result<()> {
        let port = self.installed_port(&plan.inputs.install)?;
        let qualification = InstallQualification::from_port(&port, plan.inputs.host)?;
        let copied = InstallRecord {
            path: payload.into(),
            ..plan.inputs.install.clone()
        };
        Installer::new(self.library().clone())?.verify_critical(&copied, &qualification)?;
        let setup_root =
            setup_output_root(&port, payload, &payload.join(&copied.selected_executable))?;
        for relative in &port.setup_output_paths {
            let target = payload.join(relative);
            crate::path::refuse_symlink_ancestors(&target)?;
            if target.is_dir() {
                fs::remove_dir_all(&target)?;
            } else if target.exists() {
                fs::remove_file(&target)?;
            }
        }
        let receipt = payload.join(RECEIPT_FILE);
        if receipt.exists() {
            fs::remove_file(&receipt)?;
        }
        let setup_metadata = setup_root.join(crate::adapter::UPSTREAM_SETUP_METADATA);
        if setup_metadata.exists() {
            fs::remove_file(&setup_metadata)?;
        }
        let operation_root = payload
            .parent()
            .ok_or_else(|| PortcoveError::state("private payload has no operation root"))?;
        let source = setup_source_path(&port, payload, operation_root)?;
        if let Some(parent) = source.parent() {
            fs::create_dir_all(parent)?;
        }
        if let Some(tool) = &plan.inputs.conversion_tool
            && tool_identity(tool.path.clone(), ChildProcessClass::HostTool)? != *tool
        {
            return Err(PortcoveError::verification(
                "conversion tool changed before preparation",
            ));
        }
        emit(operation.message("info", "Materializing the reviewed source"));
        if plan.inputs.conversion_tool.is_some() {
            record_preparation_process_quiescence(self, operation.operation_id(), false)?;
        }
        let mut conversion_quiesced =
            || record_preparation_process_quiescence(self, operation.operation_id(), true);
        crate::adapter::prepare_runtime_source_with_tool(
            &plan.inputs.source.path,
            &source,
            port.runtime_source_materialization.ok_or_else(|| {
                PortcoveError::state("managed preparation has no source materialization contract")
            })?,
            &port.runtime_source_hashes,
            plan.inputs
                .conversion_tool
                .as_ref()
                .map(|tool| tool.path.as_path()),
            &|| operation.checkpoint(),
            crate::tool_process::ToolProcessObserver {
                diagnostics: Some(crate::tool_process::ToolDiagnosticSink {
                    activity_id: operation.operation_id(),
                    phase: "preparation.extract",
                    record: &mut |capture| self.library().record_activity_diagnostic(capture),
                }),
                quiesced: plan
                    .inputs
                    .conversion_tool
                    .as_ref()
                    .map(|_| &mut conversion_quiesced as &mut dyn FnMut() -> Result<()>),
            },
        )
        .map_err(|error| error.during("preparation.extract"))?;
        let setup_relative = plan
            .inputs
            .setup_tool
            .path
            .strip_prefix(&plan.inputs.install.path)
            .map_err(|_| {
                PortcoveError::verification("setup tool escaped the reviewed installation")
            })?;
        let setup = payload.join(setup_relative);
        let actual = tool_identity(setup.clone(), ChildProcessClass::UpstreamSetup)?;
        if actual.sha256 != plan.inputs.setup_tool.sha256
            || actual.size != plan.inputs.setup_tool.size
        {
            return Err(PortcoveError::verification(
                "private setup executable differs from the reviewed tool",
            ));
        }
        let before = crate::library_transfer::reviewed_tree(payload)?;
        let permissions = before
            .files
            .iter()
            .map(|file| {
                Ok((
                    file.relative_path.clone(),
                    crate::permissions::executable_intent(&payload.join(&file.relative_path))?,
                ))
            })
            .collect::<Result<BTreeMap<_, _>>>()?;
        emit(operation.message("info", "Running the reviewed default upstream setup"));
        record_preparation_process_quiescence(self, operation.operation_id(), false)?;
        let mut setup_quiesced =
            || record_preparation_process_quiescence(self, operation.operation_id(), true);
        let isolated_setup = port.adapter == crate::AdapterKind::LibultrashipPortable;
        let setup_directory = if isolated_setup {
            let directory = operation_root.join("setup-runtime");
            fs::create_dir(&directory)?;
            directory
        } else {
            setup_root.clone()
        };
        let setup_environment = if isolated_setup {
            std::collections::BTreeMap::from([(
                "SHIP_HOME".to_owned(),
                crate::path::unicode(&setup_directory, "private setup directory")?,
            )])
        } else {
            std::collections::BTreeMap::new()
        };
        let output = crate::tool_process::run_setup(
            &setup,
            &port.setup_arguments,
            &source,
            &setup_directory,
            &setup_environment,
            &|| operation.checkpoint(),
            crate::tool_process::ToolProcessObserver {
                diagnostics: Some(crate::tool_process::ToolDiagnosticSink {
                    activity_id: operation.operation_id(),
                    phase: "preparation.setup",
                    record: &mut |capture| self.library().record_activity_diagnostic(capture),
                }),
                quiesced: Some(&mut setup_quiesced),
            },
        )
        .map_err(|error| error.during("preparation.setup"))?;
        tracing::info!(
            port_id = port.id,
            output = output.output,
            truncated = output.truncated,
            "managed setup diagnostics"
        );
        if !output.status.success() {
            return Err(PortcoveError::source(format!(
                "upstream setup rejected or could not prepare the source (exit {})",
                output.status.code().unwrap_or(-1)
            ))
            .during("preparation.setup")
            .detail("exit_code", output.status.code().unwrap_or(-1).to_string()));
        }
        self.check_lifecycle_fault(LifecycleFaultPoint::PreparationToolCompleted)?;
        if isolated_setup {
            copy_setup_outputs(&port, &setup_directory, payload)?;
        }
        validate_outputs(&port, payload, &before, &permissions)
            .map_err(|error| error.during("preparation.verify"))?;
        let marker = port
            .setup_marker
            .as_deref()
            .ok_or_else(|| PortcoveError::state("setup has no output marker"))?;
        if !setup_root.join(marker).is_file() {
            return Err(PortcoveError::verification(
                "setup completed without its declared output marker",
            )
            .during("preparation.verify"));
        }
        crate::adapter::record_prepared_setup(&setup_root, &source)?;
        if isolated_setup {
            fs::remove_dir_all(&setup_directory)?;
        }
        operation.checkpoint()
    }
}

pub(super) fn supports_single_source_setup_layout(port: &PortDefinition) -> bool {
    let materialization_supported = matches!(
        port.runtime_source_materialization,
        Some(RuntimeSourceMaterialization::Ps2Iso | RuntimeSourceMaterialization::N64BigEndian)
    ) || (port.adapter == crate::AdapterKind::UpstreamManagedSetup
        && port.runtime_source_materialization == Some(RuntimeSourceMaterialization::GamecubeIso));
    materialization_supported
        && port.runtime_source_set.is_empty()
        && port.persistent_file_patterns.is_empty()
}

pub(super) fn setup_output_root(
    port: &PortDefinition,
    payload: &Path,
    selected_executable: &Path,
) -> Result<PathBuf> {
    if port.adapter == crate::AdapterKind::UpstreamManagedSetup
        && port.runtime_subdirectory.is_some()
    {
        crate::adapter::launch_working_directory(port.adapter, port, payload, selected_executable)
    } else {
        Ok(payload.to_path_buf())
    }
}

pub(super) fn setup_source_path(
    port: &PortDefinition,
    payload: &Path,
    operation_root: &Path,
) -> Result<PathBuf> {
    let filename = port
        .runtime_source_filename
        .as_deref()
        .ok_or_else(|| PortcoveError::state("setup has no materialized source path"))?;
    if port.adapter == crate::AdapterKind::UpstreamManagedSetup
        && port.runtime_source_materialization == Some(RuntimeSourceMaterialization::GamecubeIso)
    {
        let source_root = operation_root.join("setup-source");
        fs::create_dir(&source_root)?;
        Ok(source_root.join(filename))
    } else {
        Ok(payload.join(filename))
    }
}

pub(super) fn copy_setup_outputs(
    port: &PortDefinition,
    source_root: &Path,
    payload: &Path,
) -> Result<()> {
    for (index, relative) in port.setup_output_paths.iter().enumerate() {
        let source = source_root.join(relative);
        crate::path::refuse_symlink_ancestors(&source)?;
        let metadata = match fs::symlink_metadata(&source) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        if metadata.file_type().is_symlink() || (!metadata.is_file() && !metadata.is_dir()) {
            return Err(PortcoveError::verification(
                "setup output contains an unsupported filesystem entry",
            )
            .detail("path", relative));
        }
        let destination = payload.join(relative);
        crate::path::refuse_symlink_ancestors(&destination)?;
        if metadata.is_file() {
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(&source, &destination)?;
            crate::permissions::normalize_archive_entry(&destination, false, false)?;
            continue;
        }
        let plan = crate::library_transfer::reviewed_tree(&source)?;
        crate::transfer_copy::copy_reviewed_tree(
            &source,
            &destination,
            &plan,
            &payload
                .parent()
                .ok_or_else(|| PortcoveError::state("private payload has no operation root"))?
                .join(format!("setup-output-copy-work-{index}")),
        )?;
        crate::transfer_copy::verify_reviewed_tree(&destination, &plan)?;
    }
    Ok(())
}

fn validate_outputs(
    port: &PortDefinition,
    root: &Path,
    before: &AdoptionCopyPlan,
    permissions: &BTreeMap<std::path::PathBuf, bool>,
) -> Result<()> {
    let after = crate::library_transfer::reviewed_tree(root)?;
    let output_roots = port
        .setup_output_paths
        .iter()
        .map(PathBuf::from)
        .chain(port.runtime_mutable_paths.iter().map(|relative| {
            port.runtime_subdirectory.as_deref().map_or_else(
                || PathBuf::from(relative),
                |prefix| Path::new(prefix).join(relative),
            )
        }))
        .collect::<Vec<_>>();
    let allowed = |path: &Path| {
        output_roots
            .iter()
            .any(|relative| path.starts_with(relative))
    };
    let original = before
        .files
        .iter()
        .filter(|file| !allowed(&file.relative_path))
        .collect::<Vec<_>>();
    let remaining = after
        .files
        .iter()
        .filter(|file| !allowed(&file.relative_path))
        .collect::<Vec<_>>();
    if original != remaining {
        return Err(PortcoveError::verification(
            "setup changed files outside its declared output ownership; active installation was preserved",
        ));
    }
    for file in remaining {
        if permissions.get(&file.relative_path).copied()
            != Some(crate::permissions::executable_intent(
                &root.join(&file.relative_path),
            )?)
        {
            return Err(PortcoveError::verification(
                "setup changed permissions on a preserved input",
            ));
        }
    }
    let allowed_directory = |path: &Path| {
        allowed(path)
            || output_roots
                .iter()
                .any(|relative| relative.starts_with(path))
    };
    let before_dirs = before
        .directories
        .iter()
        .filter(|path| !allowed_directory(path))
        .collect::<Vec<_>>();
    let after_dirs = after
        .directories
        .iter()
        .filter(|path| !allowed_directory(path))
        .collect::<Vec<_>>();
    if before_dirs != after_dirs {
        return Err(PortcoveError::verification(
            "setup changed directory ownership outside its declared outputs",
        ));
    }
    Ok(())
}

pub(crate) fn recover(
    service: &PortcoveService,
    store: &OperationStore,
    journal: &mut LifecycleOperation,
) -> Result<()> {
    if journal.kind != LifecycleOperationKind::Prepare {
        return Err(PortcoveError::state(
            "preparation recovery received another operation kind",
        ));
    }
    if journal.phase == LifecyclePhase::CleanupPending && journal.install.is_none() {
        let _activity_guard = service.library().try_lock_activity(&journal.id)?;
        return remove_reviewed_private_preparation(service, store, journal);
    }
    if journal.phase == LifecyclePhase::Preparing {
        let _activity_guard = service.library().try_lock_activity(&journal.id)?;
        let mut error = PortcoveError::state(
            "private preparation cannot be resumed; review its retained work and current inputs before starting a new preparation",
        )
        .with_mutation_state(MutationState::RecoveryRequired)
        .during("preparation.interrupted")
        .offer_recovery(RecoveryAction::ReviewPreparation);
        if let Some(state) =
            crate::cancellation::cancellation_state(service.library(), &journal.id)?
        {
            let belongs: bool = service.library().connection()?.query_row(
                "SELECT EXISTS(SELECT 1 FROM activity_history WHERE id=?1 AND operation='prepare' AND target_kind='port' AND target_id=?2)",
                rusqlite::params![journal.id, journal.port_id], |row| row.get(0),
            )?;
            if !belongs {
                return Err(PortcoveError::verification(
                    "preparation recovery does not own the recorded activity",
                ));
            }
            // The port and activity locks prove that no preparation worker owns
            // this attempt. They do not prove that every native child stopped,
            // so a requested cancellation is not reported as successful.
            error = error.detail("cancel_requested", state.requested.to_string());
            service.library().finish_activity_report(
                &journal.id,
                crate::ActivityStatus::Failed,
                Some(&error.message),
                Some(&error.report()),
            )?;
        }
        return Err(error);
    }
    let plan = journal
        .preparation
        .as_ref()
        .ok_or_else(|| PortcoveError::state("preparation journal has no reviewed plan"))?;
    let install = journal
        .install
        .as_ref()
        .ok_or_else(|| PortcoveError::state("preparation journal has no validated installation"))?;
    if install.id != journal.id
        || install.port_id != plan.port_id
        || journal.port_id != plan.port_id
        || install.artifact != plan.inputs.install.artifact
        || journal.paths.final_path.as_ref() != Some(&install.path)
    {
        return Err(PortcoveError::verification(
            "prepared publication does not match its reviewed operation identity",
        ));
    }
    let mut bound_plan = plan.clone();
    bound_plan.plan_sha256.clear();
    let original = crate::output_root::validate_install_path(
        service.library(),
        &journal.port_id,
        &plan.inputs.install.path,
    )?;
    let expected = original
        .parent()
        .ok_or_else(|| PortcoveError::state("preparation original has no managed parent"))?
        .join(crate::signed_catalog::digest(&serde_json::to_vec(&(
            "Portcove prepared derivative v1",
            &plan.plan_sha256,
            &journal.id,
        ))?));
    crate::path::refuse_symlink_ancestors(&install.path)?;
    if plan.format_version != 1
        || crate::signed_catalog::digest(&serde_json::to_vec(&bound_plan)?) != plan.plan_sha256
        || crate::path::resolve_existing_ancestor(&install.path)? != expected
    {
        return Err(PortcoveError::verification(
            "prepared destination or plan changed identity",
        ));
    }
    if matches!(
        journal.phase,
        LifecyclePhase::Prepared | LifecyclePhase::PayloadPublished
    ) {
        let active = service.status(&plan.port_id)?.active;
        if active.as_ref().is_none_or(|active| active.id != install.id)
            && service
                .plan_preparation_locked(&plan.port_id, plan.inputs.options)?
                .plan_sha256
                != plan.plan_sha256
        {
            return Err(PortcoveError::conflict(
                "reviewed preparation inputs changed before recovery publication",
            ));
        }
    }
    crate::recovery::recover_published_install(service, store, journal)
}

fn private_preparation_journal(
    store: &OperationStore,
    operation_id: &str,
) -> Result<LifecycleOperation> {
    store
        .all()?
        .into_iter()
        .find(|entry| entry.id == operation_id)
        .ok_or_else(|| {
            PortcoveError::not_found("retained preparation operation was not found")
                .detail("operation_id", operation_id)
        })
}

fn record_preparation_process_quiescence(
    service: &PortcoveService,
    operation_id: &str,
    quiesced: bool,
) -> Result<()> {
    let store = OperationStore::new(service.library().clone());
    let mut journal = private_preparation_journal(&store, operation_id)?;
    if journal.kind != LifecycleOperationKind::Prepare
        || journal.phase != LifecyclePhase::Preparing
        || journal.install.is_some()
    {
        return Err(PortcoveError::verification(
            "preparation process state does not match private preparation ownership",
        ));
    }
    journal.preparation_process_quiesced = Some(quiesced);
    store.put(&mut journal)
}

fn preparation_cleanup_preview(
    service: &PortcoveService,
    journal: &LifecycleOperation,
) -> Result<PreparationCleanupPreview> {
    if journal.kind != LifecycleOperationKind::Prepare
        || !matches!(
            journal.phase,
            LifecyclePhase::Preparing | LifecyclePhase::CleanupPending
        )
        || journal.install.is_some()
        || journal.relocation.is_some()
        || journal.source_import.is_some()
        || !journal.original_paths.is_empty()
        || !journal.activate
        || (journal.phase == LifecyclePhase::Preparing && journal.paths.quarantine.is_some())
        || (journal.phase == LifecyclePhase::CleanupPending && journal.paths.quarantine.is_none())
    {
        return Err(PortcoveError::conflict(
            "only unpublished private preparation work can be discarded",
        )
        .detail("operation_id", &journal.id));
    }
    let plan = journal
        .preparation
        .as_ref()
        .ok_or_else(|| PortcoveError::state("retained preparation has no reviewed input plan"))?;
    let mut bound_plan = plan.clone();
    bound_plan.plan_sha256.clear();
    if plan.format_version != 1
        || journal.port_id != plan.port_id
        || plan.inputs.install.port_id != journal.port_id
        || crate::signed_catalog::digest(&serde_json::to_vec(&bound_plan)?) != plan.plan_sha256
    {
        return Err(PortcoveError::verification(
            "retained preparation does not match its reviewed operation identity",
        ));
    }
    let activity_status: Option<String> = service.library().connection()?.query_row(
        "SELECT status FROM activity_history WHERE id=?1 AND operation='prepare' AND target_kind='port' AND target_id=?2",
        rusqlite::params![journal.id, journal.port_id],
        |row| row.get(0),
    ).optional()?;
    if !activity_status
        .as_deref()
        .is_some_and(|status| matches!(status, "failed" | "cancelled"))
    {
        return Err(PortcoveError::verification(
            "retained preparation does not own a terminal failed activity",
        ));
    }
    if journal.preparation_process_quiesced != Some(true) {
        return Err(PortcoveError::conflict(
            "retained preparation process quiescence is not proven; cleanup is refused",
        )
        .detail("operation_id", &journal.id)
        .detail("recovery_action", "manual_review"));
    }
    let retained_path =
        journal.paths.staging.clone().ok_or_else(|| {
            PortcoveError::state("retained preparation has no private staging path")
        })?;
    crate::output_root::validate_staging_path(
        service.library(),
        &journal.port_id,
        &journal.id,
        &retained_path,
    )?;
    let original_install = crate::output_root::validate_install_path(
        service.library(),
        &journal.port_id,
        &plan.inputs.install.path,
    )?;
    let expected_final = original_install
        .parent()
        .ok_or_else(|| PortcoveError::state("recorded original has no managed parent"))?
        .join(crate::signed_catalog::digest(&serde_json::to_vec(&(
            "Portcove prepared derivative v1",
            &plan.plan_sha256,
            &journal.id,
        ))?));
    if journal.paths.final_path.as_ref() != Some(&expected_final) {
        return Err(PortcoveError::conflict(
            "planned preparation destination changed or contains unreviewed data",
        ));
    }
    match fs::symlink_metadata(&expected_final) {
        Ok(_) => {
            return Err(PortcoveError::conflict(
                "planned preparation destination changed or contains unreviewed data",
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let (inventory_path, reviewed_fingerprint) = if journal.phase == LifecyclePhase::CleanupPending
    {
        let quarantine = journal.paths.quarantine.as_ref().ok_or_else(|| {
            PortcoveError::state("reviewed preparation cleanup has no private quarantine path")
        })?;
        let reviewed_fingerprint =
            cleanup_quarantine_fingerprint(&retained_path, quarantine, &journal.id)?;
        let inventory_path = if private_directory_exists(quarantine)? {
            quarantine.as_path()
        } else {
            retained_path.as_path()
        };
        (inventory_path, Some(reviewed_fingerprint))
    } else {
        (retained_path.as_path(), None)
    };
    let retained = match fs::symlink_metadata(inventory_path) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
            crate::service::adoption_copy_plan(inventory_path)?
        }
        Ok(_) => {
            return Err(PortcoveError::conflict(
                "private preparation path changed identity",
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => AdoptionCopyPlan {
            directories: Vec::new(),
            files: Vec::new(),
            skipped_entries: Vec::new(),
            total_bytes: 0,
        },
        Err(error) => return Err(error.into()),
    };
    let mut preview = PreparationCleanupPreview {
        format_version: 1,
        operation_id: journal.id.clone(),
        port_id: journal.port_id.clone(),
        retained_path,
        retained,
        original_install_path: plan.inputs.install.path.clone(),
        source_path: plan.inputs.source.path.clone(),
        persistent_data_path: service.library().user_dir(&journal.port_id),
        backup_path: service.library().backups_dir().join(&journal.port_id),
        logs_path: service.library().logs_dir(),
        cleanup_is_irreversible: true,
        interrupted_cleanup_will_retry: true,
        preview_sha256: String::new(),
    };
    preview.preview_sha256 = crate::signed_catalog::digest(&serde_json::to_vec(&preview)?);
    if reviewed_fingerprint.is_some_and(|expected| expected != preview.preview_sha256) {
        return Err(PortcoveError::conflict(
            "retained preparation changed after cleanup was accepted; review it again",
        )
        .detail("cleanup_state_changed", "true"));
    }
    Ok(preview)
}

fn remove_reviewed_private_preparation(
    service: &PortcoveService,
    store: &OperationStore,
    journal: &mut LifecycleOperation,
) -> Result<()> {
    let staging = journal.paths.staging.clone().ok_or_else(|| {
        PortcoveError::state("reviewed preparation cleanup has no private staging path")
    })?;
    crate::output_root::validate_staging_path(
        service.library(),
        &journal.port_id,
        &journal.id,
        &staging,
    )?;
    let quarantine = journal.paths.quarantine.clone().ok_or_else(|| {
        PortcoveError::state("reviewed preparation cleanup has no private quarantine path")
    })?;
    cleanup_quarantine_fingerprint(&staging, &quarantine, &journal.id)?;
    let mut staging_exists = private_directory_exists(&staging)?;
    let mut quarantine_exists = private_directory_exists(&quarantine)?;
    if !staging_exists && !quarantine_exists {
        return store.remove(&journal.id);
    }

    match preparation_cleanup_preview(service, journal) {
        Ok(_) => {}
        Err(error) if error.details.contains_key("cleanup_state_changed") => {
            restore_private_cleanup_for_review(store, journal, &staging, &quarantine)?;
            return Err(error);
        }
        Err(error) => return Err(error),
    };
    if !quarantine_exists {
        fs::rename(&staging, &quarantine)?;
        staging_exists = false;
        quarantine_exists = true;
        if let Err(error) = preparation_cleanup_preview(service, journal) {
            restore_private_cleanup_for_review(store, journal, &staging, &quarantine)?;
            return Err(error);
        }
    }
    if quarantine_exists {
        fs::remove_dir_all(&quarantine)?;
    }
    if !staging_exists {
        staging_exists = private_directory_exists(&staging)?;
    }
    if staging_exists {
        journal.phase = LifecyclePhase::Preparing;
        journal.paths.quarantine = None;
        journal.last_error = Some(
            "reviewed private files were removed, but new private files appeared and require review"
                .into(),
        );
        store.put(journal)?;
        return Err(PortcoveError::conflict(
            "reviewed private files were removed, but new private files appeared; review them again",
        )
        .with_mutation_state(MutationState::RecoveryRequired));
    }
    store.remove(&journal.id)
}

fn restore_private_cleanup_for_review(
    store: &OperationStore,
    journal: &mut LifecycleOperation,
    staging: &Path,
    quarantine: &Path,
) -> Result<()> {
    if private_directory_exists(quarantine)? {
        if private_directory_exists(staging)? {
            return Err(PortcoveError::conflict(
                "both reviewed and newly retained private preparation files exist; cleanup cannot continue",
            )
            .with_mutation_state(MutationState::RecoveryRequired));
        }
        fs::rename(quarantine, staging)?;
    }
    journal.phase = LifecyclePhase::Preparing;
    journal.paths.quarantine = None;
    journal.last_error = Some("retained preparation changed and requires another review".into());
    store.put(journal)
}

fn private_directory_exists(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => Ok(true),
        Ok(_) => Err(PortcoveError::conflict(
            "private preparation path changed identity",
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

pub(super) fn cleanup_quarantine_path(
    staging: &Path,
    operation_id: &str,
    fingerprint: &str,
) -> Result<std::path::PathBuf> {
    validate_cleanup_fingerprint(fingerprint)?;
    let parent = staging
        .parent()
        .ok_or_else(|| PortcoveError::state("private preparation staging path has no parent"))?;
    Ok(parent.join(format!("{operation_id}.cleanup.{fingerprint}")))
}

fn cleanup_quarantine_fingerprint(
    staging: &Path,
    quarantine: &Path,
    operation_id: &str,
) -> Result<String> {
    let name = quarantine
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| PortcoveError::conflict("private cleanup path has no portable identity"))?;
    let prefix = format!("{operation_id}.cleanup.");
    let fingerprint = name
        .strip_prefix(&prefix)
        .ok_or_else(|| PortcoveError::conflict("private cleanup path changed identity"))?;
    validate_cleanup_fingerprint(fingerprint)?;
    if quarantine != cleanup_quarantine_path(staging, operation_id, fingerprint)? {
        return Err(PortcoveError::conflict(
            "private cleanup path changed identity",
        ));
    }
    crate::path::refuse_symlink_ancestors(quarantine)?;
    Ok(fingerprint.to_owned())
}

fn validate_cleanup_fingerprint(fingerprint: &str) -> Result<()> {
    if fingerprint.len() != 64
        || !fingerprint
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        return Err(PortcoveError::usage(
            "reviewed preparation cleanup fingerprint is not a canonical SHA-256 digest",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod capacity_tests {
    use super::{GAMECUBE_DISC_CAPACITY_BYTES, preparation_capacity_bytes};
    use crate::RuntimeSourceMaterialization;

    #[test]
    fn compressed_gamecube_preparation_reserves_full_disc_and_generated_output() {
        let copied_install = 100_000_000;
        let compressed_source = 200_000_000;
        let required = preparation_capacity_bytes(
            copied_install,
            compressed_source,
            Some(RuntimeSourceMaterialization::GamecubeIso),
        )
        .unwrap();
        assert_eq!(required, copied_install + 2 * GAMECUBE_DISC_CAPACITY_BYTES);
        assert_eq!(
            preparation_capacity_bytes(
                copied_install,
                GAMECUBE_DISC_CAPACITY_BYTES + 1,
                Some(RuntimeSourceMaterialization::GamecubeIso),
            )
            .unwrap(),
            copied_install + 2 * GAMECUBE_DISC_CAPACITY_BYTES + 1
        );
    }

    #[test]
    fn preparation_capacity_preserves_other_materialization_and_rejects_overflow() {
        assert_eq!(preparation_capacity_bytes(100, 200, None).unwrap(), 300);
        assert!(
            preparation_capacity_bytes(
                u64::MAX,
                1,
                Some(RuntimeSourceMaterialization::GamecubeIso),
            )
            .is_err()
        );
    }
}
