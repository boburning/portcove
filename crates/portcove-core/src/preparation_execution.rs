use std::{collections::BTreeMap, fs, path::Path};

use super::{PreparationInputs, PreparationOptions, PreparationPlan, RECEIPT_FILE, tool_identity};
use crate::{
    ActivityOperation, ActivityTargetKind, AdoptionCopyPlan, ChildProcessClass,
    DestructiveAuthorization, InstallQualification, InstallRecord, Installer, OperationCoordinator,
    OperationEvent, OperationResult, PortDefinition, PortcoveError, PortcoveService, Result,
    RuntimeSourceMaterialization,
    operation::{
        LifecycleFaultPoint, LifecycleOperation, LifecycleOperationKind, LifecyclePhase,
        OperationStore,
    },
};

#[derive(serde::Serialize, serde::Deserialize)]
struct PreparationReceipt {
    format_version: u32,
    plan_sha256: String,
    inputs: PreparationInputs,
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
            ));
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
        let plan = self.plan_preparation_locked(port_id, options)?;
        let port = self.catalog().port(port_id)?;
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
        let result = self.prepare_derivative(&plan, &operation, &mut emit);
        if let Err(error) = &result {
            let store = OperationStore::new(self.library().clone());
            if let Some(mut journal) = store
                .all()?
                .into_iter()
                .find(|entry| entry.id == activity.id)
            {
                // Private work is retained on failure, including when a hard
                // interruption leaves a tool's lifetime uncertain. A retry uses
                // another operation ID; it never reuses or removes partial work.
                journal.last_error = Some(error.message.clone());
                store.put(&mut journal)?;
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
        self.prepare_private_inputs(plan, &payload, operation, emit)?;
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
        let port = self.catalog().port(&plan.port_id)?;
        let qualification = InstallQualification::from_port(port, plan.inputs.host)?;
        let installer = Installer::new(self.library().clone())?;
        let mut install = installer.create_prepared_manifest(
            original,
            operation.operation_id(),
            &qualification,
            &payload,
        )?;
        installer.verify_critical(&install, &qualification)?;
        if !installer.verify_managed(&install, &qualification)?.valid {
            return Err(PortcoveError::verification(
                "prepared output failed its immutable manifest check",
            ));
        }
        crate::adapter::bind_upstream_setup_manifest(&payload, &install.manifest_sha256)?;
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
        let port = self.catalog().port(&plan.port_id)?;
        let qualification = InstallQualification::from_port(port, plan.inputs.host)?;
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
        )?;
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
        )?;
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
            )));
        }
        self.check_lifecycle_fault(LifecycleFaultPoint::PreparationToolCompleted)?;
        validate_outputs(port, payload, &before, &permissions)?;
        let marker = port
            .setup_marker
            .as_deref()
            .ok_or_else(|| PortcoveError::state("setup has no output marker"))?;
        if !payload.join(marker).is_file() {
            return Err(PortcoveError::verification(
                "setup completed without its declared output marker",
            ));
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
        return Err(PortcoveError::state(
            "private preparation was interrupted; retained for inspection, and retry will start a new private attempt",
        ));
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
    crate::output_root::validate_install_path(service.library(), &journal.port_id, &install.path)?;
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
