use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    ActivityOperation, ActivityTargetKind, AdoptionCopyPlan, DestructiveAuthorization,
    InstallQualification, InstallRecord, Installer, Library, OutputDestinationAvailability,
    OutputDestinationOwnership, PortOutputLocation, PortcoveError, PortcoveService, Result,
    operation::{
        LifecycleFaultPoint, LifecycleOperation, LifecycleOperationKind, LifecyclePhase,
        OperationStore,
    },
};

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct OutputRelocationInstall {
    pub install: InstallRecord,
    pub destination_path: PathBuf,
    pub active: bool,
    pub previous: bool,
    pub staged: bool,
    pub retained: bool,
    pub copy: AdoptionCopyPlan,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct OutputRelocationPlan {
    pub port_id: String,
    pub current: PortOutputLocation,
    pub channel: crate::ReleaseChannel,
    pub destination_root: PathBuf,
    pub installs: Vec<OutputRelocationInstall>,
    pub required_bytes: u64,
    pub available_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    pub volume_identity: Option<String>,
    pub availability: OutputDestinationAvailability,
    pub ownership: OutputDestinationOwnership,
    pub validation_errors: Vec<String>,
    pub sources_will_move: bool,
    pub user_data_will_move: bool,
    pub backups_will_move: bool,
    pub plan_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct OutputRelocationResult {
    pub operation_id: String,
    pub port_id: String,
    pub output_location: PortOutputLocation,
    pub relocated_installs: Vec<InstallRecord>,
    pub old_paths_retained: Vec<PathBuf>,
    pub cleanup_pending: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct OutputRelocationStatus {
    pub operation_id: String,
    pub port_id: String,
    pub phase: String,
    pub destination_root: PathBuf,
    pub cleanup_pending_paths: Vec<PathBuf>,
    pub last_error: Option<String>,
}

impl PortcoveService {
    pub fn plan_output_relocation(
        &self,
        port_id: &str,
        destination: &Path,
    ) -> Result<OutputRelocationPlan> {
        let port = self.catalog().port(port_id)?;
        if self.output_relocation_status(port_id)?.is_some() {
            return Err(PortcoveError::conflict(
                "this game already has an unfinished relocation; restart Portcove to retry recovery",
            )
            .detail("port_id", port_id)
            .detail("recovery_action", "restart_then_doctor"));
        }
        if destination.as_os_str().is_empty() || !destination.is_absolute() {
            return Err(PortcoveError::usage(
                "relocation destination must be a nonempty absolute path",
            ));
        }
        crate::path::unicode(destination, "game relocation destination")?;
        let destination_root =
            crate::path::normalized_absolute(destination, "game relocation destination")?;
        let current = self.output_location(port_id, None)?;
        let status = self.library().status(port_id, default_channel(port))?;
        let channel = status.channel;
        let active = status.active.as_ref().map(|install| install.id.as_str());
        let previous = status.previous.as_ref().map(|install| install.id.as_str());
        let staged = status.staged.as_ref().map(|install| install.id.as_str());
        let qualification = InstallQualification::from_port(port, crate::Platform::current()?)?;
        let installer = Installer::new(self.library().clone())?;
        let mut records = self
            .library()
            .all_installs()?
            .into_iter()
            .filter(|install| install.port_id == port_id)
            .collect::<Vec<_>>();
        records.sort_by(|left, right| left.id.cmp(&right.id));
        if records.is_empty() {
            return Err(PortcoveError::not_found(format!(
                "{port_id} has no installed versions to relocate"
            )));
        }

        let mut installs = Vec::new();
        let mut validation_errors = Vec::new();
        let mut required_bytes = 0_u64;
        for install in records {
            crate::output_root::validate_install_path(self.library(), port_id, &install.path)?;
            let report = installer.verify_managed(&install, &qualification)?;
            if !report.valid {
                return Err(PortcoveError::verification(
                    "an installed version failed verification before relocation",
                )
                .detail("install_id", &install.id)
                .detail("failures", report.failures.join(", ")));
            }
            installer.verify_critical(&install, &qualification)?;
            let name = install.path.file_name().ok_or_else(|| {
                PortcoveError::state("registered install path has no version directory name")
            })?;
            let destination_path = destination_root.join(name);
            if destination_path == install.path {
                continue;
            }
            match fs::symlink_metadata(&destination_path) {
                Ok(_) => validation_errors.push(format!(
                    "destination already contains the version path {}",
                    destination_path.display()
                )),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => validation_errors
                    .push(format!("destination version path is unavailable: {error}")),
            }
            let copy = crate::library_transfer::reviewed_tree(&install.path)?;
            required_bytes = required_bytes
                .checked_add(copy.total_bytes)
                .ok_or_else(|| PortcoveError::state("relocation size overflowed"))?;
            let is_active = active == Some(install.id.as_str());
            let is_previous = previous == Some(install.id.as_str());
            let is_staged = staged == Some(install.id.as_str());
            installs.push(OutputRelocationInstall {
                install,
                destination_path,
                active: is_active,
                previous: is_previous,
                staged: is_staged,
                retained: !is_active && !is_previous && !is_staged,
                copy,
            });
        }
        if installs.is_empty() {
            return Err(PortcoveError::conflict(
                "all installed versions are already in the requested destination",
            ));
        }

        let assessment =
            crate::output_root::assess_destination(self.library(), port_id, &destination_root);
        validation_errors.extend(assessment.validation_errors);
        if assessment
            .available_bytes
            .is_some_and(|available| available < required_bytes)
        {
            validation_errors.push(format!(
                "destination needs {required_bytes} bytes but only {} bytes are available",
                assessment.available_bytes.unwrap_or_default()
            ));
        }
        let mut plan = OutputRelocationPlan {
            port_id: port_id.to_owned(),
            current,
            channel,
            destination_root,
            installs,
            required_bytes,
            available_bytes: assessment.available_bytes,
            total_bytes: assessment.total_bytes,
            volume_identity: assessment.volume_identity,
            availability: assessment.availability,
            ownership: assessment.ownership,
            validation_errors,
            sources_will_move: false,
            user_data_will_move: false,
            backups_will_move: false,
            plan_sha256: String::new(),
        };
        plan.plan_sha256 = relocation_fingerprint(&plan)?;
        Ok(plan)
    }

    pub fn authorize_output_relocation(
        &self,
        port_id: &str,
        destination: &Path,
        expected_plan_sha256: &str,
    ) -> Result<DestructiveAuthorization> {
        let plan = self.plan_output_relocation(port_id, destination)?;
        if plan.plan_sha256 != expected_plan_sha256 {
            return Err(PortcoveError::conflict(
                "installed versions or relocation destination changed after review; review again",
            ));
        }
        require_valid_relocation(&plan)?;
        self.library().issue_authorization(
            "relocate_output",
            &relocation_target(port_id, destination)?,
            &plan.plan_sha256,
        )
    }

    pub fn relocate_output(
        &self,
        port_id: &str,
        destination: &Path,
        authorization_token: &str,
    ) -> Result<OutputRelocationResult> {
        let activity = self.library().begin_activity(
            ActivityOperation::RelocateOutput,
            ActivityTargetKind::Port,
            Some(port_id),
        )?;
        let result = (|| {
            let _guard = self.library().try_lock_port(port_id, "relocate-output")?;
            let plan = self.plan_output_relocation(port_id, destination)?;
            require_valid_relocation(&plan)?;
            self.library().consume_authorization(
                authorization_token,
                "relocate_output",
                &relocation_target(port_id, destination)?,
                &plan.plan_sha256,
            )?;
            let prepared = crate::output_root::prepare_for_install(
                self.library(),
                port_id,
                &plan.destination_root,
                &activity.id,
                plan.required_bytes,
            )?;
            if prepared.root != plan.destination_root {
                return Err(PortcoveError::conflict(
                    "relocation destination changed identity before copying",
                ));
            }
            let store = OperationStore::new(self.library().clone());
            let mut operation =
                LifecycleOperation::new(&activity.id, LifecycleOperationKind::Relocate, port_id);
            operation.paths.staging = Some(prepared.operation_root);
            operation.paths.final_path = Some(plan.destination_root.clone());
            operation.original_paths = plan
                .installs
                .iter()
                .map(|entry| entry.install.path.clone())
                .collect();
            operation.relocation = Some(plan);
            store.put(&mut operation)?;
            self.check_lifecycle_fault(LifecycleFaultPoint::RelocationJournaled)?;
            execute_relocation(self, &store, &mut operation)
        })();
        self.finish_activity(activity, result)
    }

    pub fn output_relocation_status(
        &self,
        port_id: &str,
    ) -> Result<Option<OutputRelocationStatus>> {
        let operation = OperationStore::new(self.library().clone())
            .all()?
            .into_iter()
            .find(|operation| {
                operation.kind == LifecycleOperationKind::Relocate && operation.port_id == port_id
            });
        operation
            .map(|operation| {
                let destination_root = operation.paths.final_path.ok_or_else(|| {
                    PortcoveError::state(
                        "recoverable output relocation is missing its destination root",
                    )
                })?;
                Ok(OutputRelocationStatus {
                    operation_id: operation.id,
                    port_id: operation.port_id,
                    phase: operation.phase.to_string(),
                    destination_root,
                    cleanup_pending_paths: operation
                        .original_paths
                        .into_iter()
                        .filter(|path| path.exists())
                        .collect(),
                    last_error: operation.last_error,
                })
            })
            .transpose()
    }
}

pub(crate) fn recover(
    service: &PortcoveService,
    store: &OperationStore,
    operation: &mut LifecycleOperation,
) -> Result<()> {
    execute_relocation(service, store, operation).map(|_| ())
}

fn execute_relocation(
    service: &PortcoveService,
    store: &OperationStore,
    operation: &mut LifecycleOperation,
) -> Result<OutputRelocationResult> {
    let plan = operation.relocation.clone().ok_or_else(|| {
        PortcoveError::state("recoverable output relocation is missing its reviewed plan")
    })?;
    if operation.phase == LifecyclePhase::Preparing {
        verify_old_authority(service, &plan)?;
        let operation_root = operation.paths.staging.as_ref().ok_or_else(|| {
            PortcoveError::state("recoverable output relocation is missing destination staging")
        })?;
        crate::output_root::validate_staging_path(
            service.library(),
            &plan.port_id,
            &operation.id,
            operation_root,
        )?;
        fs::create_dir_all(operation_root)?;
        service.check_lifecycle_fault(LifecycleFaultPoint::RelocationCopyStarted)?;
        let work = operation_root.join(".copy-work");
        for entry in &plan.installs {
            crate::transfer_copy::copy_reviewed_tree(
                &entry.install.path,
                &operation_root.join(&entry.install.id),
                &entry.copy,
                &work,
            )?;
            service.check_lifecycle_fault(LifecycleFaultPoint::RelocationCopied)?;
        }
        for entry in &plan.installs {
            crate::transfer_copy::verify_reviewed_tree(&entry.install.path, &entry.copy)?;
        }
        verify_staged(service, &plan, operation_root)?;
        operation.phase = LifecyclePhase::Prepared;
        operation.last_error = None;
        store.put(operation)?;
        service.check_lifecycle_fault(LifecycleFaultPoint::RelocationPrepared)?;
    }

    if operation.phase == LifecyclePhase::Prepared {
        let operation_root = operation.paths.staging.as_ref().ok_or_else(|| {
            PortcoveError::state("recoverable output relocation is missing destination staging")
        })?;
        for entry in &plan.installs {
            let staged = operation_root.join(&entry.install.id);
            match (staged.exists(), entry.destination_path.exists()) {
                (true, false) => {
                    service.check_lifecycle_fault(
                        LifecycleFaultPoint::RelocationPublicationPrepared,
                    )?;
                    crate::durability::rename_noreplace(&staged, &entry.destination_path)?;
                    crate::durability::sync_publication(&plan.destination_root)?;
                }
                (false, true) => {}
                (true, true) => {
                    return Err(PortcoveError::conflict(
                        "both private staging and a final relocation path exist",
                    )
                    .detail("install_id", &entry.install.id));
                }
                (false, false) => {
                    return Err(PortcoveError::state(
                        "a prepared relocation copy disappeared before publication",
                    )
                    .detail("install_id", &entry.install.id));
                }
            }
            crate::transfer_copy::verify_reviewed_tree(&entry.destination_path, &entry.copy)?;
        }
        operation.phase = LifecyclePhase::PayloadPublished;
        store.put(operation)?;
        service.check_lifecycle_fault(LifecycleFaultPoint::RelocationPublished)?;
    }

    if operation.phase == LifecyclePhase::PayloadPublished {
        match authority_state(service.library(), &plan)? {
            AuthorityState::Old => commit_new_authority(service.library(), &plan)?,
            AuthorityState::New => {}
        }
        operation.phase = LifecyclePhase::MetadataCommitted;
        store.put(operation)?;
    }

    if matches!(
        operation.phase,
        LifecyclePhase::MetadataCommitted | LifecyclePhase::CleanupPending
    ) {
        verify_new_authority(service, &plan)?;
        let cleanup_fault = service
            .check_lifecycle_fault(LifecycleFaultPoint::RelocationMetadataCommitted)
            .err();
        let mut cleanup_errors = Vec::new();
        if let Some(error) = cleanup_fault {
            cleanup_errors.push(error.message);
        } else {
            for entry in &plan.installs {
                if let Err(error) = remove_old_copy(service.library(), &plan.port_id, entry) {
                    cleanup_errors.push(format!("{}: {}", entry.install.path.display(), error));
                }
            }
            if let Some(staging) = &operation.paths.staging
                && staging.exists()
                && let Err(error) = fs::remove_dir_all(staging)
            {
                cleanup_errors.push(format!("{}: {error}", staging.display()));
            }
        }
        if !cleanup_errors.is_empty() {
            operation.phase = LifecyclePhase::CleanupPending;
            operation.last_error = Some(cleanup_errors.join("; "));
            store.put(operation)?;
            return relocation_result(service, operation, &plan, true);
        }
        if let Err(error) =
            service.check_lifecycle_fault(LifecycleFaultPoint::RelocationCleanupCompleted)
        {
            operation.phase = LifecyclePhase::CleanupPending;
            operation.last_error = Some(error.message);
            store.put(operation)?;
            return relocation_result(service, operation, &plan, true);
        }
        store.remove(&operation.id)?;
        return relocation_result(service, operation, &plan, false);
    }

    Err(PortcoveError::state(
        "output relocation has an unsupported recovery phase",
    ))
}

fn verify_old_authority(service: &PortcoveService, plan: &OutputRelocationPlan) -> Result<()> {
    if authority_state(service.library(), plan)? != AuthorityState::Old {
        return Err(PortcoveError::conflict(
            "relocation metadata changed before destination publication",
        ));
    }
    let current = service.output_location(&plan.port_id, None)?;
    if relocation_fingerprint_with_current(plan, &current)? != plan.plan_sha256 {
        return Err(PortcoveError::conflict(
            "installed versions or output preference changed after relocation review",
        ));
    }
    for entry in &plan.installs {
        crate::transfer_copy::verify_reviewed_tree(&entry.install.path, &entry.copy)?;
    }
    Ok(())
}

fn verify_staged(
    service: &PortcoveService,
    plan: &OutputRelocationPlan,
    operation_root: &Path,
) -> Result<()> {
    let installer = Installer::new(service.library().clone())?;
    let qualification = InstallQualification::from_port(
        service.catalog().port(&plan.port_id)?,
        crate::Platform::current()?,
    )?;
    for entry in &plan.installs {
        let path = operation_root.join(&entry.install.id);
        crate::transfer_copy::verify_reviewed_tree(&path, &entry.copy)?;
        let staged = InstallRecord {
            path,
            ..entry.install.clone()
        };
        let report = installer.verify_managed(&staged, &qualification)?;
        if !report.valid {
            return Err(PortcoveError::verification(
                "a staged relocation copy failed immutable verification",
            )
            .detail("install_id", &entry.install.id)
            .detail("failures", report.failures.join(", ")));
        }
        installer.verify_critical(&staged, &qualification)?;
    }
    Ok(())
}

fn verify_new_authority(service: &PortcoveService, plan: &OutputRelocationPlan) -> Result<()> {
    if authority_state(service.library(), plan)? != AuthorityState::New {
        return Err(PortcoveError::conflict(
            "relocation metadata does not identify the published destination",
        ));
    }
    let installer = Installer::new(service.library().clone())?;
    let qualification = InstallQualification::from_port(
        service.catalog().port(&plan.port_id)?,
        crate::Platform::current()?,
    )?;
    for entry in &plan.installs {
        let relocated = InstallRecord {
            path: entry.destination_path.clone(),
            ..entry.install.clone()
        };
        crate::output_root::validate_install_path(
            service.library(),
            &plan.port_id,
            &relocated.path,
        )?;
        let report = installer.verify_managed(&relocated, &qualification)?;
        if !report.valid {
            return Err(PortcoveError::verification(
                "the authoritative relocated installation failed verification",
            )
            .detail("install_id", &entry.install.id)
            .detail("failures", report.failures.join(", ")));
        }
        installer.verify_critical(&relocated, &qualification)?;
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AuthorityState {
    Old,
    New,
}

fn authority_state(library: &Library, plan: &OutputRelocationPlan) -> Result<AuthorityState> {
    let current = library
        .all_installs()?
        .into_iter()
        .map(|install| (install.id.clone(), install))
        .collect::<HashMap<_, _>>();
    let mut old = 0;
    let mut new = 0;
    for entry in &plan.installs {
        let install = current.get(&entry.install.id).ok_or_else(|| {
            PortcoveError::conflict("an install disappeared during relocation")
                .detail("install_id", &entry.install.id)
        })?;
        if same_install(install, &entry.install, &entry.install.path)? {
            old += 1;
        } else if same_install(install, &entry.install, &entry.destination_path)? {
            new += 1;
        } else {
            return Err(PortcoveError::conflict(
                "an install changed identity or path during relocation",
            )
            .detail("install_id", &entry.install.id));
        }
    }
    match (old, new) {
        (count, 0) if count == plan.installs.len() => Ok(AuthorityState::Old),
        (0, count) if count == plan.installs.len() => Ok(AuthorityState::New),
        _ => Err(PortcoveError::state(
            "relocation metadata contains a partial authority transition",
        )),
    }
}

fn same_install(
    current: &InstallRecord,
    reviewed: &InstallRecord,
    expected_path: &Path,
) -> Result<bool> {
    let mut expected = reviewed.clone();
    expected.path = expected_path.to_path_buf();
    Ok(serde_json::to_value(current)? == serde_json::to_value(expected)?)
}

fn commit_new_authority(library: &Library, plan: &OutputRelocationPlan) -> Result<()> {
    let mut connection = library.connection()?;
    let transaction = connection.transaction()?;
    for entry in &plan.installs {
        let old_path = crate::path::unicode(&entry.install.path, "old install path")?;
        let new_path = crate::path::unicode(&entry.destination_path, "new install path")?;
        let changed = transaction.execute(
            "UPDATE installs SET path=?1
             WHERE id=?2 AND port_id=?3 AND path=?4 AND artifact_sha256=?5
               AND manifest_sha256=?6 AND selected_executable=?7",
            rusqlite::params![
                new_path,
                entry.install.id,
                entry.install.port_id,
                old_path,
                entry.install.artifact.sha256,
                entry.install.manifest_sha256,
                crate::path::unicode(&entry.install.selected_executable, "selected executable")?,
            ],
        )?;
        if changed != 1 {
            return Err(PortcoveError::conflict(
                "an install changed before relocation metadata commit",
            )
            .detail("install_id", &entry.install.id));
        }
    }
    transaction.execute(
        "INSERT INTO port_settings(port_id, channel, update_policy, output_directory)
         VALUES (?1, ?2, 'notify', ?3)
         ON CONFLICT(port_id) DO UPDATE SET output_directory=excluded.output_directory",
        rusqlite::params![
            plan.port_id,
            plan.channel.to_string(),
            crate::path::unicode(&plan.destination_root, "game relocation destination")?,
        ],
    )?;
    transaction.commit()?;
    Ok(())
}

fn remove_old_copy(
    library: &Library,
    port_id: &str,
    entry: &OutputRelocationInstall,
) -> Result<()> {
    match fs::symlink_metadata(&entry.install.path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        result => {
            result?;
        }
    }
    crate::output_root::validate_install_path(library, port_id, &entry.install.path)?;
    verify_remaining_tree(&entry.install.path, &entry.copy)?;
    fs::remove_dir_all(&entry.install.path)?;
    crate::durability::sync_publication(
        entry
            .install
            .path
            .parent()
            .ok_or_else(|| PortcoveError::state("old install path has no parent"))?,
    )
}

fn verify_remaining_tree(root: &Path, expected: &AdoptionCopyPlan) -> Result<()> {
    let actual = crate::library_transfer::reviewed_tree(root)?;
    let expected_files = expected
        .files
        .iter()
        .map(|file| (&file.relative_path, (file.size, file.sha256.as_str())))
        .collect::<HashMap<_, _>>();
    for file in &actual.files {
        if expected_files.get(&file.relative_path) != Some(&(file.size, file.sha256.as_str())) {
            return Err(PortcoveError::conflict(
                "old relocation copy changed after the new location became authoritative; it was retained",
            )
            .detail("path", root.display().to_string()));
        }
    }
    let expected_directories = expected
        .directories
        .iter()
        .collect::<std::collections::HashSet<_>>();
    if actual
        .directories
        .iter()
        .any(|directory| !expected_directories.contains(directory))
        || !actual.skipped_entries.is_empty()
    {
        return Err(PortcoveError::conflict(
            "old relocation copy contains new or unsupported entries; it was retained",
        )
        .detail("path", root.display().to_string()));
    }
    Ok(())
}

fn relocation_result(
    service: &PortcoveService,
    operation: &LifecycleOperation,
    plan: &OutputRelocationPlan,
    cleanup_pending: bool,
) -> Result<OutputRelocationResult> {
    let relocated_installs = plan
        .installs
        .iter()
        .map(|entry| InstallRecord {
            path: entry.destination_path.clone(),
            ..entry.install.clone()
        })
        .collect();
    Ok(OutputRelocationResult {
        operation_id: operation.id.clone(),
        port_id: plan.port_id.clone(),
        output_location: service.output_location(&plan.port_id, None)?,
        relocated_installs,
        old_paths_retained: plan
            .installs
            .iter()
            .map(|entry| entry.install.path.clone())
            .filter(|path| path.exists())
            .collect(),
        cleanup_pending,
    })
}

fn require_valid_relocation(plan: &OutputRelocationPlan) -> Result<()> {
    let safe_ownership = matches!(
        plan.ownership,
        OutputDestinationOwnership::LibraryDefault
            | OutputDestinationOwnership::Unclaimed
            | OutputDestinationOwnership::OwnedByPort
    );
    if plan.validation_errors.is_empty()
        && plan.availability == OutputDestinationAvailability::Available
        && safe_ownership
        && plan
            .available_bytes
            .is_none_or(|available| available >= plan.required_bytes)
    {
        return Ok(());
    }
    Err(PortcoveError::conflict(
        "relocation destination is not safe; review the validation results",
    )
    .detail("plan_sha256", &plan.plan_sha256)
    .detail("validation_errors", plan.validation_errors.join("; ")))
}

fn relocation_fingerprint(plan: &OutputRelocationPlan) -> Result<String> {
    relocation_fingerprint_with_current(plan, &plan.current)
}

fn relocation_fingerprint_with_current(
    plan: &OutputRelocationPlan,
    current: &PortOutputLocation,
) -> Result<String> {
    let capacity_sufficient = plan
        .available_bytes
        .is_none_or(|available| available >= plan.required_bytes);
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(&(
        "Portcove output relocation plan v1",
        &plan.port_id,
        current,
        plan.channel,
        &plan.destination_root,
        &plan.installs,
        plan.required_bytes,
        plan.availability,
        plan.ownership,
        capacity_sufficient,
        &plan.volume_identity,
        &plan.validation_errors,
    ))?)))
}

fn relocation_target(port_id: &str, destination: &Path) -> Result<String> {
    Ok(format!(
        "{port_id}\n{}",
        crate::path::unicode(destination, "game relocation destination")?
    ))
}

fn default_channel(port: &crate::PortDefinition) -> crate::ReleaseChannel {
    if port.channels.contains(&crate::ReleaseChannel::Stable) {
        crate::ReleaseChannel::Stable
    } else {
        port.channels[0]
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::Path,
        sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        },
    };

    use sha2::{Digest, Sha256};
    use tempfile::TempDir;
    use uuid::Uuid;

    use super::*;
    use crate::{
        ArtifactIdentity, Catalog, ErrorCode, Platform, ReleaseChannel, SourceRecord,
        operation::{LifecycleFaultInjector, LifecycleFaultPoint},
    };

    const PORT: &str = "zelda64-recomp";

    #[derive(Debug)]
    struct FailAt(LifecycleFaultPoint);

    impl LifecycleFaultInjector for FailAt {
        fn check(&self, point: LifecycleFaultPoint) -> Result<()> {
            if point == self.0 {
                Err(PortcoveError::state(format!(
                    "injected relocation fault at {point:?}"
                )))
            } else {
                Ok(())
            }
        }
    }

    #[derive(Debug)]
    struct ChangeSourceDuringCopy(PathBuf);

    impl LifecycleFaultInjector for ChangeSourceDuringCopy {
        fn check(&self, point: LifecycleFaultPoint) -> Result<()> {
            if point == LifecycleFaultPoint::RelocationCopied {
                fs::write(self.0.join("late-change.bin"), b"changed during copy").unwrap();
            }
            Ok(())
        }
    }

    #[derive(Debug)]
    struct CreateLateRelocationDestination {
        destination: PathBuf,
        fired: AtomicBool,
    }

    impl LifecycleFaultInjector for CreateLateRelocationDestination {
        fn check(&self, point: LifecycleFaultPoint) -> Result<()> {
            if point == LifecycleFaultPoint::RelocationPublicationPrepared
                && !self.fired.swap(true, Ordering::SeqCst)
            {
                fs::create_dir(&self.destination)?;
            }
            Ok(())
        }
    }

    struct Fixture {
        _temporary: TempDir,
        library: Library,
        destination: PathBuf,
        original: Vec<InstallRecord>,
        protected_files: Vec<(PathBuf, Vec<u8>)>,
    }

    impl Fixture {
        fn new() -> Self {
            let temporary = tempfile::tempdir().unwrap();
            let library = Library::open(temporary.path().join("library")).unwrap();
            let original = vec![
                register_install(&library, PORT, "retained", false),
                register_install(&library, PORT, "previous", true),
                register_install(&library, PORT, "active", true),
                register_install(&library, PORT, "staged", false),
            ];
            let protected_files = [
                library.root().join("sources").join("shared-source.bin"),
                library.user_dir(PORT).join("save.dat"),
                library.backups_dir().join(PORT).join("backup.dat"),
            ]
            .into_iter()
            .enumerate()
            .map(|(index, path)| {
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                let contents = format!("protected-{index}").into_bytes();
                fs::write(&path, &contents).unwrap();
                (path, contents)
            })
            .collect::<Vec<_>>();
            let (source_path, source_contents) = &protected_files[0];
            let source_sha256 = hex::encode(Sha256::digest(source_contents));
            library
                .register_source(&SourceRecord {
                    profile_id: "majoras-mask".into(),
                    path: source_path.clone(),
                    sha256: source_sha256.clone(),
                    size: source_contents.len() as u64,
                    storage_sha256: source_sha256,
                    storage_size: source_contents.len() as u64,
                    updated_at: Library::now(),
                    observed_identity: None,
                })
                .unwrap();
            Self {
                destination: temporary.path().join("relocated").join(PORT),
                _temporary: temporary,
                library,
                original,
                protected_files,
            }
        }

        fn assert_protected_files_unchanged(&self) {
            for (path, contents) in &self.protected_files {
                assert_eq!(&fs::read(path).unwrap(), contents);
            }
        }
    }

    fn register_install(
        library: &Library,
        port_id: &str,
        version: &str,
        active: bool,
    ) -> InstallRecord {
        let artifact = ArtifactIdentity {
            asset_name: format!("{port_id}-{version}.zip"),
            sha256: hex::encode(Sha256::digest(format!("{port_id}:{version}"))),
            size: version.len() as u64,
        };
        let path = library.versions_dir().join(port_id).join(&artifact.sha256);
        fs::create_dir_all(&path).unwrap();
        let catalog = Catalog::embedded().unwrap();
        let port = catalog.port(port_id).unwrap();
        let platform = Platform::current().unwrap();
        let executable = path.join(&port.executable_hints[&platform][0]);
        fs::create_dir_all(executable.parent().unwrap()).unwrap();
        fs::write(&executable, format!("executable-{version}")).unwrap();
        crate::permissions::normalize_archive_entry(&executable, false, true).unwrap();
        fs::write(path.join("engine.dll"), format!("engine-{version}")).unwrap();
        let id = Uuid::new_v4().to_string();
        let qualification = InstallQualification::from_port(port, platform).unwrap();
        let (manifest_sha256, selected_executable, runtime) = Installer::new(library.clone())
            .unwrap()
            .create_manifest(&id, port_id, version, &artifact, &qualification, &path)
            .unwrap();
        let install = InstallRecord {
            id,
            port_id: port_id.into(),
            version: version.into(),
            path,
            channel: ReleaseChannel::Stable,
            installed_at: Library::now(),
            verified: true,
            staged: !active,
            artifact,
            manifest_sha256,
            selected_executable,
            runtime,
        };
        library.register_install(&install, active).unwrap();
        install
    }

    fn authorize(service: &PortcoveService, destination: &Path) -> String {
        let plan = service.plan_output_relocation(PORT, destination).unwrap();
        assert!(
            plan.validation_errors.is_empty(),
            "{:?}",
            plan.validation_errors
        );
        service
            .authorize_output_relocation(PORT, destination, &plan.plan_sha256)
            .unwrap()
            .token
    }

    #[test]
    fn preview_is_read_only_and_relocation_preserves_roles_and_central_data() {
        let fixture = Fixture::new();
        let service = PortcoveService::new(fixture.library.clone()).unwrap();
        let before = fixture.library.all_installs().unwrap();
        let original_status = status_record_ids(
            &fixture
                .library
                .status(PORT, ReleaseChannel::Stable)
                .unwrap(),
        );
        let plan = service
            .plan_output_relocation(PORT, &fixture.destination)
            .unwrap();

        assert_eq!(plan.installs.len(), 4);
        assert_eq!(plan.installs.iter().filter(|item| item.active).count(), 1);
        assert_eq!(plan.installs.iter().filter(|item| item.previous).count(), 1);
        assert_eq!(plan.installs.iter().filter(|item| item.staged).count(), 1);
        assert_eq!(plan.installs.iter().filter(|item| item.retained).count(), 1);
        assert!(!plan.sources_will_move);
        assert!(!plan.user_data_will_move);
        assert!(!plan.backups_will_move);
        assert!(!fixture.destination.exists());
        assert_eq!(
            serde_json::to_value(fixture.library.all_installs().unwrap()).unwrap(),
            serde_json::to_value(&before).unwrap()
        );
        assert!(fixture.library.output_directory(PORT).unwrap().is_none());

        let token = service
            .authorize_output_relocation(PORT, &fixture.destination, &plan.plan_sha256)
            .unwrap()
            .token;
        let result = service
            .relocate_output(PORT, &fixture.destination, &token)
            .unwrap();

        assert!(!result.cleanup_pending);
        assert!(result.old_paths_retained.is_empty());
        assert_eq!(result.relocated_installs.len(), 4);
        assert_eq!(
            fixture.library.output_directory(PORT).unwrap().as_deref(),
            Some(plan.destination_root.as_path())
        );
        let after = fixture
            .library
            .status(PORT, ReleaseChannel::Stable)
            .unwrap();
        assert_eq!(status_record_ids(&after), original_status);
        for original in &fixture.original {
            assert!(!original.path.exists());
            let relocated = result
                .relocated_installs
                .iter()
                .find(|install| install.id == original.id)
                .unwrap();
            assert!(relocated.path.starts_with(&plan.destination_root));
            assert_eq!(relocated.artifact, original.artifact);
            assert!(
                Installer::new(fixture.library.clone())
                    .unwrap()
                    .verify(relocated)
                    .unwrap()
                    .valid
            );
        }
        fixture.assert_protected_files_unchanged();
        assert!(service.output_relocation_status(PORT).unwrap().is_none());
        let activity = fixture.library.activities(10).unwrap().remove(0);
        assert_eq!(activity.operation, ActivityOperation::RelocateOutput);
        assert_eq!(activity.status, crate::ActivityStatus::Succeeded);
    }

    fn status_record_ids(
        status: &crate::PortStatus,
    ) -> (Option<String>, Option<String>, Option<String>) {
        (
            status.active.as_ref().map(|install| install.id.clone()),
            status.previous.as_ref().map(|install| install.id.clone()),
            status.staged.as_ref().map(|install| install.id.clone()),
        )
    }

    #[test]
    fn authorization_rejects_changed_install_state() {
        let fixture = Fixture::new();
        let service = PortcoveService::new(fixture.library.clone()).unwrap();
        let plan = service
            .plan_output_relocation(PORT, &fixture.destination)
            .unwrap();
        let token = service
            .authorize_output_relocation(PORT, &fixture.destination, &plan.plan_sha256)
            .unwrap()
            .token;
        fs::write(fixture.original[0].path.join("changed.bin"), b"changed").unwrap();
        let error = service
            .relocate_output(PORT, &fixture.destination, &token)
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::Verification);
        assert!(fixture.library.output_directory(PORT).unwrap().is_none());
        assert!(fixture.original.iter().all(|install| install.path.exists()));
    }

    #[test]
    fn authorization_rejects_destination_collisions() {
        let collision_case = Fixture::new();
        let collision_service = PortcoveService::new(collision_case.library.clone()).unwrap();
        let collision = collision_case
            .destination
            .join(collision_case.original[0].path.file_name().unwrap());
        fs::create_dir_all(&collision).unwrap();
        let collision_plan = collision_service
            .plan_output_relocation(PORT, &collision_case.destination)
            .unwrap();
        assert!(!collision_plan.validation_errors.is_empty());
        assert_eq!(
            collision_service
                .authorize_output_relocation(
                    PORT,
                    &collision_case.destination,
                    &collision_plan.plan_sha256,
                )
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
    }

    #[test]
    fn authorization_rejects_unavailable_volumes() {
        let volume_case = Fixture::new();
        let volume_service = PortcoveService::new(volume_case.library.clone()).unwrap();
        let _volume = crate::output_root::override_volume_details(
            crate::output_root::TestVolumeDetails::Unavailable("drive disconnected".into()),
        );
        let unavailable = volume_service
            .plan_output_relocation(PORT, &volume_case.destination)
            .unwrap();
        assert_eq!(
            unavailable.availability,
            OutputDestinationAvailability::Unavailable
        );
        assert_eq!(
            volume_service
                .authorize_output_relocation(
                    PORT,
                    &volume_case.destination,
                    &unavailable.plan_sha256,
                )
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
    }

    #[test]
    fn authorization_rejects_full_volumes() {
        let full_case = Fixture::new();
        let full_service = PortcoveService::new(full_case.library.clone()).unwrap();
        let _full_volume = crate::output_root::override_volume_details(
            crate::output_root::TestVolumeDetails::Available {
                available_bytes: 0,
                total_bytes: 1024,
                volume_identity: "full-test-volume".into(),
            },
        );
        let full = full_service
            .plan_output_relocation(PORT, &full_case.destination)
            .unwrap();
        assert_eq!(full.availability, OutputDestinationAvailability::Full);
        assert_eq!(
            full_service
                .authorize_output_relocation(PORT, &full_case.destination, &full.plan_sha256)
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
    }

    #[test]
    fn relocation_honors_the_port_mutation_lock() {
        let fixture = Fixture::new();
        let service = PortcoveService::new(fixture.library.clone()).unwrap();
        let token = authorize(&service, &fixture.destination);
        let _lock = fixture.library.try_lock_port(PORT, "test-busy").unwrap();
        let error = service
            .relocate_output(PORT, &fixture.destination, &token)
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::Conflict);
        assert!(fixture.library.output_directory(PORT).unwrap().is_none());
    }

    #[test]
    fn source_change_during_copy_prevents_publication() {
        let fixture = Fixture::new();
        let service = PortcoveService::with_faults(
            fixture.library.clone(),
            Arc::new(ChangeSourceDuringCopy(fixture.original[0].path.clone())),
        )
        .unwrap();
        let token = authorize(&service, &fixture.destination);
        let error = service
            .relocate_output(PORT, &fixture.destination, &token)
            .unwrap_err();

        assert_eq!(error.code, ErrorCode::Verification);
        assert!(fixture.library.output_directory(PORT).unwrap().is_none());
        assert!(fixture.original.iter().all(|install| install.path.exists()));
        assert!(
            fixture
                .library
                .all_installs()
                .unwrap()
                .iter()
                .all(|install| !install.path.starts_with(&fixture.destination))
        );
    }

    #[test]
    fn ports_with_a_shared_source_relocate_to_independent_roots() {
        let fixture = Fixture::new();
        const SECOND_PORT: &str = "2ship2harkinian";
        let second = register_install(&fixture.library, SECOND_PORT, "active", true);
        let first_service = PortcoveService::new(fixture.library.clone()).unwrap();
        let first_plan = first_service
            .plan_output_relocation(PORT, &fixture.destination)
            .unwrap();
        let first_token = first_service
            .authorize_output_relocation(PORT, &fixture.destination, &first_plan.plan_sha256)
            .unwrap()
            .token;
        first_service
            .relocate_output(PORT, &fixture.destination, &first_token)
            .unwrap();

        let second_destination = fixture
            ._temporary
            .path()
            .join("second-relocated")
            .join(SECOND_PORT);
        let second_plan = first_service
            .plan_output_relocation(SECOND_PORT, &second_destination)
            .unwrap();
        let second_token = first_service
            .authorize_output_relocation(SECOND_PORT, &second_destination, &second_plan.plan_sha256)
            .unwrap()
            .token;
        first_service
            .relocate_output(SECOND_PORT, &second_destination, &second_token)
            .unwrap();

        assert_ne!(
            fixture.library.output_directory(PORT).unwrap(),
            fixture.library.output_directory(SECOND_PORT).unwrap()
        );
        assert!(
            fixture
                .library
                .status(PORT, ReleaseChannel::Stable)
                .unwrap()
                .active
                .unwrap()
                .path
                .starts_with(&first_plan.destination_root)
        );
        assert!(
            fixture
                .library
                .status(SECOND_PORT, ReleaseChannel::Stable)
                .unwrap()
                .active
                .unwrap()
                .path
                .starts_with(&second_plan.destination_root)
        );
        assert!(!second.path.exists());
        let source = fixture.library.source("majoras-mask").unwrap().unwrap();
        assert_eq!(source.path, fixture.protected_files[0].0);
        fixture.assert_protected_files_unchanged();
    }

    fn assert_relocation_recovers(point: LifecycleFaultPoint) {
        let fixture = Fixture::new();
        let service =
            PortcoveService::with_faults(fixture.library.clone(), Arc::new(FailAt(point))).unwrap();
        let token = authorize(&service, &fixture.destination);
        let result = service.relocate_output(PORT, &fixture.destination, &token);
        match point {
            LifecycleFaultPoint::RelocationMetadataCommitted
            | LifecycleFaultPoint::RelocationCleanupCompleted => {
                assert!(result.unwrap().cleanup_pending);
            }
            _ => {
                assert_eq!(result.unwrap_err().code, ErrorCode::State);
            }
        }
        assert!(service.output_relocation_status(PORT).unwrap().is_some());

        let recovered = PortcoveService::new(fixture.library.clone()).unwrap();
        assert!(recovered.output_relocation_status(PORT).unwrap().is_none());
        let expected_destination =
            crate::path::normalized_absolute(&fixture.destination, "test relocation destination")
                .unwrap();
        assert_eq!(
            fixture.library.output_directory(PORT).unwrap().as_deref(),
            Some(expected_destination.as_path()),
            "fault {point:?}"
        );
        let installs = fixture.library.all_installs().unwrap();
        assert_eq!(installs.len(), fixture.original.len());
        assert!(
            installs
                .iter()
                .all(|install| install.path.starts_with(&expected_destination)),
            "fault {point:?}"
        );
        assert!(
            fixture
                .original
                .iter()
                .all(|install| !install.path.exists())
        );
        fixture.assert_protected_files_unchanged();
    }

    #[test]
    fn recovers_relocation_journaled_to_one_authority() {
        assert_relocation_recovers(LifecycleFaultPoint::RelocationJournaled);
    }

    #[test]
    fn recovers_relocation_copy_started_to_one_authority() {
        assert_relocation_recovers(LifecycleFaultPoint::RelocationCopyStarted);
    }

    #[test]
    fn recovers_relocation_copied_to_one_authority() {
        assert_relocation_recovers(LifecycleFaultPoint::RelocationCopied);
    }

    #[test]
    fn recovers_relocation_prepared_to_one_authority() {
        assert_relocation_recovers(LifecycleFaultPoint::RelocationPrepared);
    }

    #[test]
    fn recovers_relocation_publication_prepared_to_one_authority() {
        assert_relocation_recovers(LifecycleFaultPoint::RelocationPublicationPrepared);
    }

    #[test]
    fn recovers_relocation_published_to_one_authority() {
        assert_relocation_recovers(LifecycleFaultPoint::RelocationPublished);
    }

    #[test]
    fn recovers_relocation_metadata_committed_to_one_authority() {
        assert_relocation_recovers(LifecycleFaultPoint::RelocationMetadataCommitted);
    }

    #[test]
    fn recovers_relocation_cleanup_completed_to_one_authority() {
        assert_relocation_recovers(LifecycleFaultPoint::RelocationCleanupCompleted);
    }

    #[test]
    fn late_empty_relocation_destination_is_preserved_until_controlled_resolution() {
        let fixture = Fixture::new();
        let service = PortcoveService::new(fixture.library.clone()).unwrap();
        let plan = service
            .plan_output_relocation(PORT, &fixture.destination)
            .unwrap();
        let token = service
            .authorize_output_relocation(PORT, &fixture.destination, &plan.plan_sha256)
            .unwrap()
            .token;
        let late_destination = plan.installs[0].destination_path.clone();
        let service = PortcoveService::with_faults(
            fixture.library.clone(),
            Arc::new(CreateLateRelocationDestination {
                destination: late_destination.clone(),
                fired: AtomicBool::new(false),
            }),
        )
        .unwrap();

        let error = service
            .relocate_output(PORT, &fixture.destination, &token)
            .unwrap_err();

        assert_eq!(error.code, ErrorCode::Conflict);
        assert!(late_destination.is_dir());
        assert!(fs::read_dir(&late_destination).unwrap().next().is_none());
        assert!(fixture.original.iter().all(|install| install.path.exists()));
        assert!(fixture.library.output_directory(PORT).unwrap().is_none());
        drop(service);

        let conflicted_restart = PortcoveService::new(fixture.library.clone()).unwrap();
        assert!(late_destination.is_dir());
        assert!(fs::read_dir(&late_destination).unwrap().next().is_none());
        assert!(fixture.original.iter().all(|install| install.path.exists()));
        assert!(fixture.library.output_directory(PORT).unwrap().is_none());
        assert!(
            conflicted_restart
                .output_relocation_status(PORT)
                .unwrap()
                .is_some()
        );
        drop(conflicted_restart);

        fs::remove_dir(&late_destination).unwrap();
        let recovered = PortcoveService::new(fixture.library.clone()).unwrap();
        assert!(recovered.output_relocation_status(PORT).unwrap().is_none());
        assert_eq!(
            fixture.library.output_directory(PORT).unwrap().as_deref(),
            Some(plan.destination_root.as_path())
        );
        assert!(
            fixture
                .library
                .all_installs()
                .unwrap()
                .iter()
                .all(|install| install.path.starts_with(&plan.destination_root))
        );
        assert!(
            fixture
                .original
                .iter()
                .all(|install| !install.path.exists())
        );
        fixture.assert_protected_files_unchanged();
    }

    #[test]
    fn changed_old_content_is_retained_until_cleanup_is_safe() {
        let fixture = Fixture::new();
        let service = PortcoveService::with_faults(
            fixture.library.clone(),
            Arc::new(FailAt(LifecycleFaultPoint::RelocationMetadataCommitted)),
        )
        .unwrap();
        let token = authorize(&service, &fixture.destination);
        let result = service
            .relocate_output(PORT, &fixture.destination, &token)
            .unwrap();
        assert!(result.cleanup_pending);
        let changed_old_path = fixture.original[0].path.join("new-user-content.bin");
        fs::write(&changed_old_path, b"do not delete").unwrap();

        let recovered = PortcoveService::new(fixture.library.clone()).unwrap();
        let status = recovered.output_relocation_status(PORT).unwrap().unwrap();
        assert_eq!(status.phase, LifecyclePhase::CleanupPending.to_string());
        assert!(
            status
                .cleanup_pending_paths
                .contains(&fixture.original[0].path)
        );
        assert!(changed_old_path.exists());
        assert!(
            fixture
                .library
                .all_installs()
                .unwrap()
                .iter()
                .all(|install| install
                    .path
                    .starts_with(&result.output_location.effective_output_directory))
        );

        fs::remove_file(changed_old_path).unwrap();
        let recovered = PortcoveService::new(fixture.library.clone()).unwrap();
        assert!(recovered.output_relocation_status(PORT).unwrap().is_none());
        assert!(
            fixture
                .original
                .iter()
                .all(|install| !install.path.exists())
        );
    }
}
