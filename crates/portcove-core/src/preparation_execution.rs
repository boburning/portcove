use std::{collections::BTreeMap, fs, path::Path};

use super::{PreparationInputs, PreparationOptions, PreparationPlan, RECEIPT_FILE, tool_identity};
use crate::{
    ActivityOperation, ActivityTargetKind, AdoptionCopyPlan, ChildProcessClass,
    DestructiveAuthorization, InstallQualification, InstallRecord, Installer, MutationState,
    OperationCoordinator, OperationEvent, OperationResult, PortDefinition, PortcoveError,
    PortcoveService, RecoveryAction, Result, RuntimeSourceMaterialization,
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

impl PortcoveService {
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
        if port.runtime_source_materialization != Some(RuntimeSourceMaterialization::Ps2Iso)
            || !port.runtime_source_set.is_empty()
            || !port.persistent_file_patterns.is_empty()
        {
            return Err(PortcoveError::unsupported(
                "this preparation operation requires the reviewed single-disc setup layout",
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
        let required = plan
            .copy
            .total_bytes
            .checked_add(plan.inputs.source.storage_size)
            .ok_or_else(|| PortcoveError::state("preparation copy size overflowed"))?;
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
        crate::adapter::bind_upstream_setup_manifest(&payload, &install.manifest_sha256)
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
        for relative in &port.setup_output_paths {
            let target = payload.join(relative);
            crate::path::refuse_symlink_ancestors(&target)?;
            if target.exists() {
                fs::remove_dir_all(&target)?;
            }
        }
        for name in [RECEIPT_FILE, crate::adapter::UPSTREAM_SETUP_METADATA] {
            let target = payload.join(name);
            if target.exists() {
                fs::remove_file(&target)?;
            }
        }
        let source = payload.join(
            port.runtime_source_filename
                .as_deref()
                .ok_or_else(|| PortcoveError::state("setup has no materialized source path"))?,
        );
        if let Some(parent) = source.parent() {
            fs::create_dir_all(parent)?;
        }
        if let Some(tool) = &plan.inputs.conversion_tool {
            if tool_identity(tool.path.clone(), ChildProcessClass::HostTool)? != *tool {
                return Err(PortcoveError::verification(
                    "conversion tool changed before preparation",
                ));
            }
        }
        emit(operation.message("info", "Materializing the reviewed source"));
        crate::adapter::prepare_runtime_source_with_tool(
            &plan.inputs.source.path,
            &source,
            RuntimeSourceMaterialization::Ps2Iso,
            &port.runtime_source_hashes,
            plan.inputs
                .conversion_tool
                .as_ref()
                .map(|tool| tool.path.as_path()),
            &|| operation.checkpoint(),
            Some(crate::tool_process::ToolDiagnosticSink {
                activity_id: operation.operation_id(),
                phase: "preparation.extract",
                record: &mut |capture| self.library().record_activity_diagnostic(capture),
            }),
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
        let output = crate::tool_process::run_setup(
            &setup,
            &port.setup_arguments,
            &source,
            payload,
            &|| operation.checkpoint(),
            operation.operation_id(),
            &mut |capture| self.library().record_activity_diagnostic(capture),
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
        validate_outputs(&port, payload, &before, &permissions)
            .map_err(|error| error.during("preparation.verify"))?;
        let marker = port
            .setup_marker
            .as_deref()
            .ok_or_else(|| PortcoveError::state("setup has no output marker"))?;
        if !payload.join(marker).is_file() {
            return Err(PortcoveError::verification(
                "setup completed without its declared output marker",
            )
            .during("preparation.verify"));
        }
        crate::adapter::record_prepared_setup(payload, &source)?;
        operation.checkpoint()
    }
}

fn validate_outputs(
    port: &PortDefinition,
    root: &Path,
    before: &AdoptionCopyPlan,
    permissions: &BTreeMap<std::path::PathBuf, bool>,
) -> Result<()> {
    let after = crate::library_transfer::reviewed_tree(root)?;
    let allowed = |path: &Path| {
        port.setup_output_paths
            .iter()
            .chain(&port.runtime_mutable_paths)
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
            || port
                .setup_output_paths
                .iter()
                .chain(&port.runtime_mutable_paths)
                .any(|relative| Path::new(relative).starts_with(path))
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
