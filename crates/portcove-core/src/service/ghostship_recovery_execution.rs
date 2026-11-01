//! A finite transition from qualified 2.0.0 data and retained code to a fresh
//! derivative. Neither retained installation is synchronized or modified.

use super::{
    PortcoveService,
    ghostship_safety::{RUNTIME_DATA, RUNTIME_RECEIPT},
};
use crate::{
    AdoptionCopyPlan, InstallRecord, Installer, Library, PortcoveError, Result,
    ghostship_data_store::{self, GhostshipRecoveryIntent, RuntimeSafetyReceipt},
    operation::{
        LifecycleFaultPoint, LifecycleOperation, LifecycleOperationKind, LifecyclePhase,
        OperationStore,
    },
};
use std::{
    fs,
    path::{Path, PathBuf},
};

impl PortcoveService {
    pub fn recover_ghostship_legacy_data(
        &self,
        backup_id: &str,
        authorization_token: &str,
    ) -> Result<crate::GhostshipRecoveryResult> {
        let activity = self.library.begin_activity(
            crate::ActivityOperation::Restore,
            crate::ActivityTargetKind::Port,
            Some("ghostship"),
        )?;
        let mut result =
            self.execute_ghostship_legacy_data(backup_id, authorization_token, &activity.id);
        if let Err(error) = &mut result {
            let store = OperationStore::new(self.library.clone());
            if let Some(mut operation) = store.get(&activity.id)? {
                operation.last_error = Some(error.message.clone());
                store.put(&mut operation)?;
                error
                    .details
                    .insert("recovery_state".into(), "review_required".into());
                error
                    .details
                    .insert("operation_id".into(), activity.id.clone());
                error
                    .details
                    .insert("recovery_action".into(), "restart_then_doctor".into());
            }
        }
        self.finish_activity(activity, result)
    }

    fn execute_ghostship_legacy_data(
        &self,
        backup_id: &str,
        authorization_token: &str,
        operation_id: &str,
    ) -> Result<crate::GhostshipRecoveryResult> {
        let _guard = self
            .library
            .try_lock_port("ghostship", "legacy-data-recovery")?;
        let plan = self.plan_ghostship_legacy_recovery_locked(backup_id)?;
        self.library.consume_authorization(
            authorization_token,
            "ghostship_legacy_recovery",
            &format!("ghostship:{backup_id}"),
            &plan.plan_sha256,
        )?;
        let id = operation_id.to_owned();
        let owned = crate::output_root::validate_install_path(
            &self.library,
            "ghostship",
            &plan.legacy_install.path,
        )?;
        let output = crate::output_root::prepare_for_install(
            &self.library,
            "ghostship",
            owned
                .parent()
                .ok_or_else(|| PortcoveError::state("legacy output parent is absent"))?,
            &id,
            plan.required_bytes,
        )?;
        let active_port = self.installed_mutability_port(&plan.active_install)?;
        if self.persistence_root(&active_port, &plan.active_install.path)?
            != plan.active_install.path
        {
            return Err(PortcoveError::unsupported(
                "legacy recovery requires the retained newer runtime persistence root",
            ));
        }
        let entries = crate::persistence::entries(&active_port, &[&plan.active_install.path])?;
        let runtime_data = selected_tree(&plan.active_install_tree, &entries, true)?;
        let mut operation =
            LifecycleOperation::new(&id, LifecycleOperationKind::GhostshipRecovery, "ghostship");
        operation.activate = true;
        operation.paths.staging = Some(output.operation_root);
        operation.paths.final_path = Some(output.root.join(format!("legacy-recovery-{id}")));
        operation.paths.quarantine =
            Some(self.library.recovery_dir().join(&id).join("previous-data"));
        operation.ghostship_recovery = Some(GhostshipRecoveryIntent {
            format_version: 1,
            plan,
            canonical_safety: None,
            runtime_data,
            derivative_tree: None,
        });
        let store = OperationStore::new(self.library.clone());
        store.put(&mut operation)?;
        self.check_lifecycle_fault(LifecycleFaultPoint::GhostshipRecoveryJournaled)?;
        // Preparing evidence remains held on any error. It cannot be reclassified
        // as Prepared merely because some files happened to finish copying.
        self.prepare_ghostship_recovery(&store, &mut operation)?;
        self.recover_ghostship_legacy(&store, &mut operation)?;
        let intent = operation
            .ghostship_recovery
            .ok_or_else(|| PortcoveError::state("legacy recovery lost its snapshot identity"))?;
        let safety_backup = intent.canonical_safety.ok_or_else(|| {
            PortcoveError::state("legacy recovery lost its safety backup identity")
        })?;
        Ok(crate::GhostshipRecoveryResult {
            install: operation
                .install
                .ok_or_else(|| PortcoveError::state("legacy recovery lost its install identity"))?,
            restored_backup: intent.plan.backup,
            runtime_safety_path: safety_backup.path.join(RUNTIME_DATA),
            safety_backup,
        })
    }

    fn prepare_ghostship_recovery(
        &self,
        store: &OperationStore,
        operation: &mut LifecycleOperation,
    ) -> Result<()> {
        let mut intent = operation
            .ghostship_recovery
            .clone()
            .ok_or_else(|| PortcoveError::state("missing legacy recovery intent"))?;
        let plan = &intent.plan;
        let staging = operation
            .paths
            .staging
            .clone()
            .ok_or_else(|| PortcoveError::state("missing legacy staging"))?;
        let recovery = self.library.recovery_dir().join(&operation.id);
        for root in [&staging, &recovery] {
            crate::path::refuse_symlink_ancestors(root)?;
            fs::create_dir(root)?;
        }
        let payload = staging.join("payload");
        let staged_data = recovery.join("staged-data");
        let work = recovery.join("copy-work");
        let payload_work = staging.join("copy-work");
        let safety = self.create_backup_locked("ghostship")?;
        require_tree(&safety.path.join("data"), &plan.canonical_data)?;
        intent.canonical_safety = Some(safety.clone());
        operation.ghostship_recovery = Some(intent.clone());
        store.put(operation)?;
        self.check_lifecycle_fault(LifecycleFaultPoint::GhostshipRecoverySafetyRecorded)?;
        // The journal names the backup before the first companion write.
        crate::transfer_copy::copy_reviewed_tree(
            &plan.active_install.path,
            &safety.path.join(RUNTIME_DATA),
            &intent.runtime_data,
            &work,
        )?;
        require_tree(&safety.path.join(RUNTIME_DATA), &intent.runtime_data)?;
        let receipt = RuntimeSafetyReceipt {
            format_version: 1,
            operation_id: operation.id.clone(),
            backup_id: safety.id.clone(),
            active_install_id: plan.active_install.id.clone(),
            runtime_data: intent.runtime_data.clone(),
        };
        crate::durability::write_bytes_atomically(
            &safety.path.join(RUNTIME_RECEIPT),
            &serde_json::to_vec(&receipt)?,
            false,
        )?;
        self.check_lifecycle_fault(LifecycleFaultPoint::GhostshipRecoverySafetyPublished)?;
        crate::transfer_copy::copy_reviewed_tree(
            &plan.backup.path.join("data"),
            &staged_data,
            &plan.snapshot_data,
            &work,
        )?;
        require_tree(&staged_data, &plan.snapshot_data)?;
        self.check_lifecycle_fault(LifecycleFaultPoint::GhostshipRecoveryDataStaged)?;
        let port = self.installed_port(&plan.legacy_install)?;
        if self.persistence_root(&port, &plan.legacy_install.path)? != plan.legacy_install.path {
            return Err(PortcoveError::unsupported(
                "legacy recovery requires its retained runtime persistence root",
            ));
        }
        let entries =
            crate::persistence::entries(&port, &[&plan.legacy_install.path, &staged_data])?;
        let mut immutable = selected_tree(&plan.legacy_install_tree, &entries, false)?;
        immutable.files.retain(|file| {
            file.relative_path != Path::new(".portcove-manifest.json")
                && file.relative_path != Path::new(super::LAUNCH_MARKER)
        });
        immutable.total_bytes = immutable.files.iter().map(|file| file.size).sum();
        crate::transfer_copy::copy_reviewed_tree(
            &plan.legacy_install.path,
            &payload,
            &immutable,
            &payload_work,
        )?;
        let overlay = selected_tree(&plan.snapshot_data, &entries, true)?;
        crate::transfer_copy::copy_reviewed_tree(&staged_data, &payload, &overlay, &payload_work)?;
        let installer = Installer::new(self.library.clone())?;
        let qualification = self.installed_mutability_qualification(&plan.legacy_install)?;
        let staged = installer.create_prepared_manifest(
            &plan.legacy_install,
            &operation.id,
            &qualification,
            crate::PreparationMode::Ghostship200Legacy,
            &payload,
        )?;
        self.require_ghostship_snapshot_compatibility(&staged, &staged_data)?;
        if !installer.verify(&staged)?.valid {
            return Err(PortcoveError::verification(
                "legacy derivative verification failed",
            ));
        }
        intent.derivative_tree = Some(ghostship_data_store::reviewed_data(&payload)?);
        operation.install = Some(InstallRecord {
            path: operation
                .paths
                .final_path
                .clone()
                .ok_or_else(|| PortcoveError::state("missing legacy destination"))?,
            ..staged
        });
        operation.ghostship_recovery = Some(intent);
        operation.phase = LifecyclePhase::Prepared;
        store.put(operation)?;
        self.check_lifecycle_fault(LifecycleFaultPoint::GhostshipRecoveryPrepared)
    }

    pub(super) fn recover_ghostship_legacy(
        &self,
        store: &OperationStore,
        operation: &mut LifecycleOperation,
    ) -> Result<()> {
        self.validate_ghostship_recovery_envelope(operation)?;
        if operation.phase == LifecyclePhase::Preparing {
            return Err(PortcoveError::conflict(
                "legacy recovery preparation is incomplete; retain its private trees and safety backup for review",
            ));
        }
        let intent = operation
            .ghostship_recovery
            .clone()
            .ok_or_else(|| PortcoveError::state("missing legacy recovery intent"))?;
        let plan = &intent.plan;
        let install = operation
            .install
            .clone()
            .ok_or_else(|| PortcoveError::state("missing legacy derivative identity"))?;
        let recovery = self.library.recovery_dir().join(&operation.id);
        let staged_data = recovery.join("staged-data");
        let previous = recovery.join("previous-data");
        let canonical = self.library.user_dir("ghostship");
        let staging = operation
            .paths
            .staging
            .clone()
            .ok_or_else(|| PortcoveError::state("missing legacy staging"))?;
        let payload = staging.join("payload");
        let safety = intent
            .canonical_safety
            .as_ref()
            .ok_or_else(|| PortcoveError::state("legacy recovery lacks independent safety data"))?;
        self.require_legacy_safety(operation, &intent)?;
        if matches!(
            operation.phase,
            LifecyclePhase::Prepared | LifecyclePhase::PayloadPublished
        ) {
            self.require_legacy_recovery_authority(&intent)?;
            let tree = intent
                .derivative_tree
                .as_ref()
                .ok_or_else(|| PortcoveError::state("legacy derivative has no reviewed tree"))?;
            let derivative = match (exists(&payload)?, exists(&install.path)?) {
                (true, false) => InstallRecord {
                    path: payload.clone(),
                    ..install.clone()
                },
                (false, true) => install.clone(),
                _ => {
                    return Err(PortcoveError::conflict(
                        "legacy derivative publication has ambiguous paths",
                    ));
                }
            };
            require_tree(&derivative.path, tree)?;
            let data = if exists(&staged_data)? {
                &staged_data
            } else {
                &canonical
            };
            require_tree(data, &plan.snapshot_data)?;
            self.require_legacy_derivative(&intent, &derivative, data)?;
            self.require_ghostship_snapshot_compatibility(&derivative, data)?;
            if !Installer::new(self.library.clone())?
                .verify(&derivative)?
                .valid
            {
                return Err(PortcoveError::verification(
                    "legacy derivative changed before publication",
                ));
            }
            if operation.phase == LifecyclePhase::Prepared {
                LegacyPublication {
                    payload: &payload,
                    destination: &install.path,
                    staged_data: &staged_data,
                    canonical: &canonical,
                    previous: &previous,
                    derivative_tree: tree,
                    canonical_tree: &plan.canonical_data,
                    snapshot_tree: &plan.snapshot_data,
                }
                .publish(
                    || self.require_legacy_recovery_authority(&intent),
                    |point| self.check_lifecycle_fault(point),
                )?;
                operation.phase = LifecyclePhase::PayloadPublished;
                store.put(operation)?;
                self.check_lifecycle_fault(
                    LifecycleFaultPoint::GhostshipRecoveryPublicationRecorded,
                )?;
            }
            self.require_legacy_recovery_authority(&intent)?;
            require_tree(&canonical, &plan.snapshot_data)?;
            require_tree(&install.path, tree)?;
            self.library.commit_ghostship_recovery(operation, &intent)?;
            self.check_lifecycle_fault(LifecycleFaultPoint::GhostshipRecoveryMetadataCommitted)?;
            operation.phase = LifecyclePhase::MetadataCommitted;
        }
        // Once metadata committed, recovery is forward-only. No collection from
        // the retained newer runtime can replace the selected legacy snapshot.
        if matches!(
            operation.phase,
            LifecyclePhase::MetadataCommitted | LifecyclePhase::CleanupPending
        ) {
            require_tree(&safety.path.join("data"), &plan.canonical_data)?;
            if exists(&previous)? {
                remove_exact_tree(&previous, &plan.canonical_data)?;
            }
            self.check_lifecycle_fault(LifecycleFaultPoint::GhostshipRecoveryCleanup)?;
            // Only empty, fixed private containers are retired. Unknown work
            // remains fenced with the journal instead of broad recursive cleanup.
            for path in [
                recovery.join("copy-work"),
                staging.join("copy-work"),
                recovery.clone(),
                staging.clone(),
            ] {
                crate::path::refuse_symlink_ancestors(&path)?;
                match fs::remove_dir(path) {
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    result => result?,
                }
            }
            store.remove(&operation.id)?;
        }
        Ok(())
    }

    fn require_legacy_recovery_authority(&self, intent: &GhostshipRecoveryIntent) -> Result<()> {
        let plan = &intent.plan;
        let active_port = self.installed_mutability_port(&plan.active_install)?;
        let entries = crate::persistence::entries(&active_port, &[&plan.active_install.path])?;
        if self.persistence_root(&active_port, &plan.active_install.path)?
            != plan.active_install.path
            || selected_tree(&plan.active_install_tree, &entries, true)? != intent.runtime_data
        {
            return Err(PortcoveError::verification(
                "legacy recovery runtime safety projection differs from the effective retained persistence policy",
            ));
        }
        self.catalog.port("ghostship")?;
        if serde_json::to_value(self.library.source("ghostship-source")?)?
            != serde_json::to_value(Some(&plan.source))?
        {
            return Err(PortcoveError::source(
                "legacy recovery source registration changed",
            ));
        }
        let catalog = self.installed_catalog(&plan.legacy_install)?;
        crate::source_inspection::verify_registered(&catalog, &plan.source)?;
        let installer = Installer::new(self.library.clone())?;
        for install in [&plan.active_install, &plan.legacy_install]
            .into_iter()
            .chain(plan.staged_install.iter())
        {
            self.managed_install_root("ghostship", &install.path)?;
            installer.require_curated_operation(
                install,
                crate::definition_repository::publisher_policy::CuratedArtifactOperation::LocalUse,
            )?;
            if !installer.verify(install)?.valid {
                return Err(PortcoveError::verification(
                    "retained recovery installation changed",
                ));
            }
        }
        require_tree(&plan.active_install.path, &plan.active_install_tree)?;
        require_tree(&plan.legacy_install.path, &plan.legacy_install_tree)?;
        let status = self.library.status("ghostship", plan.channel)?;
        if serde_json::to_value((
            &status.active,
            &status.previous,
            &status.staged,
            status.channel,
            status.update_policy,
        ))? != serde_json::to_value((
            Some(&plan.active_install),
            Some(&plan.legacy_install),
            &plan.staged_install,
            plan.channel,
            plan.update_policy,
        ))? || status.external_runtime.is_some()
        {
            return Err(PortcoveError::conflict(
                "legacy recovery installation tuple changed",
            ));
        }
        let connection = self.library.connection()?;
        let qualified = ghostship_data_store::qualified_backup(&connection, &plan.backup.id)?
            .ok_or_else(|| {
                PortcoveError::verification("legacy snapshot qualification was withdrawn")
            })?;
        if qualified.1 != plan.qualification_sha256
            || serde_json::to_value(&qualified.2.install)?
                != serde_json::to_value(&plan.legacy_install)?
            || serde_json::to_value(&qualified.2.source)? != serde_json::to_value(&plan.source)?
            || qualified.2.data != plan.snapshot_data
        {
            return Err(PortcoveError::verification(
                "legacy snapshot qualification changed",
            ));
        }
        require_tree(&plan.backup.path.join("data"), &plan.snapshot_data)?;
        if crate::external_runtime::hash_stable_regular(
            &plan.backup.path.join("backup.json"),
            1024 * 1024,
            &|| Ok(()),
        )?
        .0 != qualified.0
        {
            return Err(PortcoveError::verification(
                "qualified backup manifest changed",
            ));
        }
        Ok(())
    }

    fn require_legacy_derivative(
        &self,
        intent: &GhostshipRecoveryIntent,
        derivative: &InstallRecord,
        data: &Path,
    ) -> Result<()> {
        let plan = &intent.plan;
        Installer::new(self.library.clone())?
            .require_same_retained_contract(&plan.legacy_install, derivative)?;
        if derivative.artifact != plan.legacy_install.artifact
            || derivative.selected_executable != plan.legacy_install.selected_executable
            || derivative.channel != plan.legacy_install.channel
        {
            return Err(PortcoveError::verification(
                "legacy derivative changed the historically admitted code contract",
            ));
        }
        let port = self.installed_port(&plan.legacy_install)?;
        let entries = crate::persistence::entries(&port, &[&plan.legacy_install.path, data])?;
        let mut expected = selected_tree(&plan.legacy_install_tree, &entries, false)?;
        expected.files.retain(|file| {
            file.relative_path != Path::new(".portcove-manifest.json")
                && file.relative_path != Path::new(super::LAUNCH_MARKER)
        });
        let overlay = selected_tree(&plan.snapshot_data, &entries, true)?;
        expected.files.extend(overlay.files);
        expected.directories.extend(overlay.directories);
        expected.directories.sort();
        expected.directories.dedup();
        expected
            .files
            .sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
        expected.total_bytes = expected.files.iter().map(|file| file.size).sum();
        let mut actual = ghostship_data_store::reviewed_data(&derivative.path)?;
        actual
            .files
            .retain(|file| file.relative_path != Path::new(".portcove-manifest.json"));
        actual.total_bytes = actual.files.iter().map(|file| file.size).sum();
        if actual != expected {
            return Err(PortcoveError::verification(
                "legacy derivative differs from the retained immutable code and selected persistent snapshot",
            ));
        }
        Ok(())
    }

    fn validate_ghostship_recovery_envelope(&self, operation: &LifecycleOperation) -> Result<()> {
        let intent = operation
            .ghostship_recovery
            .as_ref()
            .ok_or_else(|| PortcoveError::state("missing legacy recovery intent"))?;
        for tree in [
            &intent.plan.canonical_data,
            &intent.plan.active_install_tree,
            &intent.plan.legacy_install_tree,
            &intent.plan.snapshot_data,
            &intent.runtime_data,
        ]
        .into_iter()
        .chain(intent.derivative_tree.iter())
        {
            ghostship_data_store::validate_data_plan(tree)?;
        }
        let active_port = self.installed_mutability_port(&intent.plan.active_install)?;
        let entries =
            crate::persistence::entries(&active_port, &[&intent.plan.active_install.path])?;
        if selected_tree(&intent.plan.active_install_tree, &entries, true)? != intent.runtime_data {
            return Err(PortcoveError::verification(
                "recovery journal omits newer-runtime persistent data",
            ));
        }
        let id = uuid::Uuid::parse_str(&operation.id)
            .map_err(|_| PortcoveError::state("invalid recovery ID"))?;
        if id.to_string() != operation.id
            || operation.kind != LifecycleOperationKind::GhostshipRecovery
            || operation.port_id != "ghostship"
            || !operation.activate
            || intent.format_version != 1
            || intent.plan.library_root != self.library.root()
            || intent.plan.format_version != 1
            || super::ghostship_recovery::recovery_plan_fingerprint(&intent.plan)?
                != intent.plan.plan_sha256
            || operation.relocation.is_some()
            || operation.source_import.is_some()
            || operation.preparation.is_some()
            || operation.backup_deletion.is_some()
            || operation.preparation_process_quiesced.is_some()
            || !operation.original_paths.is_empty()
            || operation.paths.quarantine.as_ref()
                != Some(
                    &self
                        .library
                        .recovery_dir()
                        .join(&operation.id)
                        .join("previous-data"),
                )
        {
            return Err(PortcoveError::verification(
                "legacy recovery journal identity or family mismatch",
            ));
        }
        let staging = operation
            .paths
            .staging
            .as_ref()
            .ok_or_else(|| PortcoveError::state("missing recovery staging"))?;
        crate::output_root::validate_staging_path(
            &self.library,
            "ghostship",
            &operation.id,
            staging,
        )?;
        let legacy = crate::output_root::validate_install_path(
            &self.library,
            "ghostship",
            &intent.plan.legacy_install.path,
        )?;
        let destination = legacy
            .parent()
            .ok_or_else(|| PortcoveError::state("legacy output parent absent"))?
            .join(format!("legacy-recovery-{}", operation.id));
        if operation.paths.final_path.as_ref() != Some(&destination)
            || operation.install.as_ref().is_some_and(|install| {
                install.id != operation.id
                    || install.port_id != "ghostship"
                    || install.version != "2.0.0"
                    || install.path != destination
            })
        {
            return Err(PortcoveError::verification(
                "legacy recovery derivative destination mismatch",
            ));
        }
        Ok(())
    }

    fn require_legacy_safety(
        &self,
        operation: &LifecycleOperation,
        intent: &GhostshipRecoveryIntent,
    ) -> Result<()> {
        let safety = intent
            .canonical_safety
            .as_ref()
            .ok_or_else(|| PortcoveError::state("missing recovery safety backup"))?;
        if safety.id == intent.plan.backup.id {
            return Err(PortcoveError::verification(
                "recovery safety cannot reuse the selected snapshot",
            ));
        }
        let actual = self.load_backup("ghostship", &safety.id)?;
        if serde_json::to_value(actual)? != serde_json::to_value(safety)? {
            return Err(PortcoveError::verification(
                "recovery safety backup identity changed",
            ));
        }
        require_tree(&safety.path.join("data"), &intent.plan.canonical_data)?;
        require_tree(&safety.path.join(RUNTIME_DATA), &intent.runtime_data)?;
        let receipt = RuntimeSafetyReceipt {
            format_version: 1,
            operation_id: operation.id.clone(),
            backup_id: safety.id.clone(),
            active_install_id: intent.plan.active_install.id.clone(),
            runtime_data: intent.runtime_data.clone(),
        };
        if crate::external_runtime::hash_stable_regular(
            &safety.path.join(RUNTIME_RECEIPT),
            1024 * 1024,
            &|| Ok(()),
        )?
        .0 != crate::signed_catalog::digest(&serde_json::to_vec(&receipt)?)
        {
            return Err(PortcoveError::verification(
                "recovery runtime safety receipt changed",
            ));
        }
        Ok(())
    }
}

/// The caller proves journal ownership, historical admission, safety copies and
/// content interpretation. This finite protocol rechecks current authority at
/// each rename and handles a crash before the enclosing phase write.
struct LegacyPublication<'a> {
    payload: &'a Path,
    destination: &'a Path,
    staged_data: &'a Path,
    canonical: &'a Path,
    previous: &'a Path,
    derivative_tree: &'a AdoptionCopyPlan,
    canonical_tree: &'a AdoptionCopyPlan,
    snapshot_tree: &'a AdoptionCopyPlan,
}

impl LegacyPublication<'_> {
    fn publish(
        &self,
        authority: impl Fn() -> Result<()>,
        fault: impl Fn(LifecycleFaultPoint) -> Result<()>,
    ) -> Result<()> {
        fault(LifecycleFaultPoint::GhostshipRecoveryBeforePublication)?;
        authority()?;
        match (exists(self.payload)?, exists(self.destination)?) {
            (true, false) => {
                require_tree(self.payload, self.derivative_tree)?;
                authority()?;
                crate::durability::rename_noreplace(self.payload, self.destination)?;
                fault(LifecycleFaultPoint::GhostshipRecoveryPayloadPublished)?;
            }
            (false, true) => require_tree(self.destination, self.derivative_tree)?,
            _ => {
                return Err(PortcoveError::conflict(
                    "legacy derivative publication paths are ambiguous",
                ));
            }
        }
        match (
            exists(self.canonical)?,
            exists(self.previous)?,
            exists(self.staged_data)?,
        ) {
            (true, false, true) => {
                require_tree(self.canonical, self.canonical_tree)?;
                require_tree(self.staged_data, self.snapshot_tree)?;
                authority()?;
                crate::durability::rename_noreplace(self.canonical, self.previous)?;
                fault(LifecycleFaultPoint::GhostshipRecoveryCanonicalQuarantined)?;
            }
            (false, true, true) | (true, true, false) => {}
            _ => {
                return Err(PortcoveError::conflict(
                    "legacy canonical publication paths are ambiguous",
                ));
            }
        }
        require_tree(self.previous, self.canonical_tree)?;
        if exists(self.staged_data)? {
            require_tree(self.staged_data, self.snapshot_tree)?;
            authority()?;
            crate::durability::rename_noreplace(self.staged_data, self.canonical)?;
            fault(LifecycleFaultPoint::GhostshipRecoveryCanonicalPublished)?;
        }
        require_tree(self.canonical, self.snapshot_tree)?;
        require_tree(self.destination, self.derivative_tree)
    }
}

fn selected_tree(
    tree: &AdoptionCopyPlan,
    entries: &[String],
    include: bool,
) -> Result<AdoptionCopyPlan> {
    ghostship_data_store::validate_data_plan(tree)?;
    let keys = entries
        .iter()
        .map(|entry| crate::portable_tree::validate_relative_path(entry, false).map(|(_, key)| key))
        .collect::<Result<Vec<_>>>()?;
    let mut selected_paths = std::collections::BTreeSet::new();
    for path in tree
        .directories
        .iter()
        .chain(tree.files.iter().map(|file| &file.relative_path))
    {
        let (_, key) = crate::portable_tree::validate_relative_path(
            &crate::portability::portable_relative(path)?,
            false,
        )?;
        if keys.iter().any(|entry| {
            key == *entry
                || key
                    .strip_prefix(entry)
                    .is_some_and(|suffix| suffix.starts_with('/'))
        }) {
            selected_paths.insert(path.clone());
        }
    }
    let selected = |path: &Path| selected_paths.contains(path);
    let files: Vec<_> = tree
        .files
        .iter()
        .filter(|file| selected(&file.relative_path) == include)
        .cloned()
        .collect();
    let directories = tree
        .directories
        .iter()
        .filter(|path| {
            selected(path) == include
                || files
                    .iter()
                    .any(|file| file.relative_path.starts_with(path))
        })
        .cloned()
        .collect();
    Ok(AdoptionCopyPlan {
        total_bytes: files.iter().map(|file| file.size).sum(),
        files,
        directories,
        skipped_entries: vec![],
    })
}
fn exists(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}
fn require_tree(root: &Path, tree: &AdoptionCopyPlan) -> Result<()> {
    if &ghostship_data_store::reviewed_data(root)? != tree {
        return Err(PortcoveError::verification(
            "legacy recovery tree preimage changed",
        ));
    }
    Ok(())
}
fn remove_exact_tree(root: &Path, tree: &AdoptionCopyPlan) -> Result<()> {
    ghostship_data_store::validate_data_plan(tree)?;
    let actual = ghostship_data_store::reviewed_data(root)?;
    if actual.files.iter().any(|file| !tree.files.contains(file))
        || actual
            .directories
            .iter()
            .any(|path| !tree.directories.contains(path))
    {
        return Err(PortcoveError::verification(
            "recovery cleanup tree gained or changed a member",
        ));
    }
    for file in &actual.files {
        let path = root.join(&file.relative_path);
        let actual = crate::external_runtime::hash_stable_regular(&path, file.size, &|| Ok(()))?;
        if actual != (file.sha256.clone(), file.size) {
            return Err(PortcoveError::verification(
                "recovery cleanup member changed",
            ));
        }
        fs::remove_file(path)?;
    }
    let mut directories: Vec<PathBuf> = actual.directories;
    directories.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
    for directory in directories {
        fs::remove_dir(root.join(directory))?;
    }
    fs::remove_dir(root)?;
    Ok(())
}

impl Library {
    fn commit_ghostship_recovery(
        &self,
        operation: &LifecycleOperation,
        intent: &GhostshipRecoveryIntent,
    ) -> Result<()> {
        let plan = &intent.plan;
        let install = operation
            .install
            .as_ref()
            .ok_or_else(|| PortcoveError::state("missing recovery install"))?;
        let safety = intent
            .canonical_safety
            .as_ref()
            .ok_or_else(|| PortcoveError::state("missing recovery safety"))?;
        let mut connection = self.connection()?;
        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let tuple: (Option<String>, Option<String>, String, String) = transaction.query_row(
            "SELECT active_install_id,previous_install_id,channel,update_policy FROM port_settings WHERE port_id='ghostship'",
            [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
        if tuple
            != (
                Some(plan.active_install.id.clone()),
                Some(plan.legacy_install.id.clone()),
                plan.channel.to_string(),
                plan.update_policy.to_string(),
            )
        {
            return Err(PortcoveError::conflict(
                "legacy recovery pointer preimage changed before commit",
            ));
        }
        for expected in [&plan.active_install, &plan.legacy_install]
            .into_iter()
            .chain(plan.staged_install.iter())
        {
            if serde_json::to_value(Self::install_by_id(&transaction, Some(&expected.id))?)?
                != serde_json::to_value(Some(expected))?
            {
                return Err(PortcoveError::conflict(
                    "legacy recovery install record changed before commit",
                ));
            }
        }
        let staged: Vec<String> = transaction
            .prepare("SELECT id FROM installs WHERE port_id='ghostship' AND staged=1 ORDER BY id")?
            .query_map([], |row| row.get(0))?
            .collect::<std::result::Result<_, _>>()?;
        if staged
            != plan
                .staged_install
                .iter()
                .map(|install| install.id.clone())
                .collect::<Vec<_>>()
            || serde_json::to_value(Self::source_from(&transaction, "ghostship-source")?)?
                != serde_json::to_value(Some(&plan.source))?
        {
            return Err(PortcoveError::conflict(
                "legacy recovery staged or source preimage changed before commit",
            ));
        }
        let pending: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM lifecycle_operations WHERE port_id='ghostship' AND id<>?1)
             OR EXISTS(SELECT 1 FROM launch_sessions WHERE port_id='ghostship' AND outcome IS NULL)
             OR EXISTS(SELECT 1 FROM external_runtime_registrations WHERE port_id='ghostship')",
            [&operation.id],
            |row| row.get(0),
        )?;
        if pending {
            return Err(PortcoveError::conflict(
                "legacy recovery encountered overlapping work before commit",
            ));
        }
        let receipt = RuntimeSafetyReceipt {
            format_version: 1,
            operation_id: operation.id.clone(),
            backup_id: safety.id.clone(),
            active_install_id: plan.active_install.id.clone(),
            runtime_data: intent.runtime_data.clone(),
        };
        let json = serde_json::to_string(&receipt)?;
        transaction.execute("INSERT INTO ghostship_runtime_safety(backup_id,receipt_sha256,receipt_json) VALUES (?1,?2,?3)",
            rusqlite::params![safety.id, crate::signed_catalog::digest(json.as_bytes()), json])?;
        Self::write_install(&transaction, install, false)?;
        transaction.execute("UPDATE port_settings SET active_install_id=?1,previous_install_id=?2 WHERE port_id='ghostship'",
            rusqlite::params![install.id, plan.active_install.id])?;
        let changed = transaction.execute("UPDATE lifecycle_operations SET phase='metadata_committed',last_error=NULL,updated_at=?2
            WHERE id=?1 AND kind='ghostship_recovery' AND port_id='ghostship' AND phase='payload_published' AND ghostship_recovery_json=?3 AND install_json=?4",
            rusqlite::params![operation.id, Library::now(), serde_json::to_string(intent)?, serde_json::to_string(install)?])?;
        if changed != 1 {
            return Err(PortcoveError::conflict(
                "legacy recovery journal changed before commit",
            ));
        }
        transaction.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct PublicationFixture {
        _temporary: tempfile::TempDir,
        payload: PathBuf,
        destination: PathBuf,
        canonical: PathBuf,
        previous: PathBuf,
        staged: PathBuf,
        runtime: PathBuf,
        derivative: AdoptionCopyPlan,
        canonical_tree: AdoptionCopyPlan,
        snapshot: AdoptionCopyPlan,
    }
    impl PublicationFixture {
        fn new() -> Self {
            let temporary = tempfile::tempdir().unwrap();
            let root = temporary.path();
            for (directory, name, bytes) in [
                ("payload", "inert-code", "retained code"),
                ("canonical", "save", "newer canonical"),
                ("staged", "save", "qualified legacy"),
                ("runtime", "save", "newer runtime"),
            ] {
                fs::create_dir(root.join(directory)).unwrap();
                fs::write(root.join(directory).join(name), bytes).unwrap();
            }
            Self {
                payload: root.join("payload"),
                destination: root.join("published"),
                canonical: root.join("canonical"),
                previous: root.join("previous"),
                staged: root.join("staged"),
                runtime: root.join("runtime"),
                derivative: ghostship_data_store::reviewed_data(&root.join("payload")).unwrap(),
                canonical_tree: ghostship_data_store::reviewed_data(&root.join("canonical"))
                    .unwrap(),
                snapshot: ghostship_data_store::reviewed_data(&root.join("staged")).unwrap(),
                _temporary: temporary,
            }
        }
        fn publication(&self) -> LegacyPublication<'_> {
            LegacyPublication {
                payload: &self.payload,
                destination: &self.destination,
                canonical: &self.canonical,
                previous: &self.previous,
                staged_data: &self.staged,
                derivative_tree: &self.derivative,
                canonical_tree: &self.canonical_tree,
                snapshot_tree: &self.snapshot,
            }
        }
    }

    #[test]
    fn ghostship_recovery_publication_resumes_each_rename_before_phase_recording() {
        for point in [
            LifecycleFaultPoint::GhostshipRecoveryBeforePublication,
            LifecycleFaultPoint::GhostshipRecoveryPayloadPublished,
            LifecycleFaultPoint::GhostshipRecoveryCanonicalQuarantined,
            LifecycleFaultPoint::GhostshipRecoveryCanonicalPublished,
        ] {
            let fixture = PublicationFixture::new();
            assert!(
                fixture
                    .publication()
                    .publish(
                        || Ok(()),
                        |actual| {
                            if actual == point {
                                Err(PortcoveError::state("inert interruption"))
                            } else {
                                Ok(())
                            }
                        }
                    )
                    .is_err()
            );
            // Reconstruct after the interruption, without relying on an in-memory
            // phase update. The newer runtime is never a collection source.
            fixture
                .publication()
                .publish(|| Ok(()), |_| Ok(()))
                .unwrap();
            require_tree(&fixture.canonical, &fixture.snapshot).unwrap();
            require_tree(&fixture.previous, &fixture.canonical_tree).unwrap();
            require_tree(&fixture.destination, &fixture.derivative).unwrap();
            assert_eq!(
                fs::read(fixture.runtime.join("save")).unwrap(),
                b"newer runtime"
            );
        }
    }

    #[test]
    fn ghostship_recovery_prepared_withdrawal_refuses_normal_and_reconstructed_publication() {
        for interrupt in [false, true] {
            let fixture = PublicationFixture::new();
            let withdrawn = std::cell::Cell::new(false);
            let authority = || {
                if withdrawn.get() {
                    Err(PortcoveError::conflict("inert current-policy withdrawal"))
                } else {
                    Ok(())
                }
            };
            let fault = |point| {
                if point == LifecycleFaultPoint::GhostshipRecoveryBeforePublication {
                    withdrawn.set(true);
                    if interrupt {
                        return Err(PortcoveError::state("interrupted before publication"));
                    }
                }
                Ok(())
            };
            assert!(fixture.publication().publish(authority, fault).is_err());
            assert!(
                fixture
                    .publication()
                    .publish(authority, |_| Ok(()))
                    .is_err()
            );
            require_tree(&fixture.payload, &fixture.derivative).unwrap();
            require_tree(&fixture.canonical, &fixture.canonical_tree).unwrap();
            require_tree(&fixture.staged, &fixture.snapshot).unwrap();
            assert!(!fixture.destination.exists());
            assert!(!fixture.previous.exists());
        }
    }

    #[test]
    fn ghostship_recovery_rechecks_authority_after_payload_rename_without_collecting_newer_data() {
        let fixture = PublicationFixture::new();
        let withdrawn = std::cell::Cell::new(false);
        let authority = || {
            if withdrawn.get() {
                Err(PortcoveError::conflict("inert current-policy withdrawal"))
            } else {
                Ok(())
            }
        };
        assert!(
            fixture
                .publication()
                .publish(authority, |point| {
                    if point == LifecycleFaultPoint::GhostshipRecoveryPayloadPublished {
                        withdrawn.set(true);
                    }
                    Ok(())
                })
                .is_err()
        );
        assert!(
            fixture
                .publication()
                .publish(authority, |_| Ok(()))
                .is_err()
        );
        require_tree(&fixture.destination, &fixture.derivative).unwrap();
        require_tree(&fixture.canonical, &fixture.canonical_tree).unwrap();
        require_tree(&fixture.staged, &fixture.snapshot).unwrap();
        assert!(!fixture.previous.exists());
        assert_eq!(
            fs::read(fixture.runtime.join("save")).unwrap(),
            b"newer runtime"
        );
    }

    #[test]
    fn ghostship_recovery_changed_stage_holds_canonical_preimage_after_interruption() {
        let fixture = PublicationFixture::new();
        assert!(
            fixture
                .publication()
                .publish(
                    || Ok(()),
                    |point| {
                        if point == LifecycleFaultPoint::GhostshipRecoveryPayloadPublished {
                            return Err(PortcoveError::state("inert interruption"));
                        }
                        Ok(())
                    }
                )
                .is_err()
        );
        fs::write(fixture.staged.join("save"), b"changed snapshot").unwrap();
        assert!(
            fixture
                .publication()
                .publish(|| Ok(()), |_| Ok(()))
                .is_err()
        );
        require_tree(&fixture.canonical, &fixture.canonical_tree).unwrap();
        assert!(!fixture.previous.exists());
    }

    fn fixture() -> (
        tempfile::TempDir,
        Library,
        LifecycleOperation,
        GhostshipRecoveryIntent,
    ) {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let seal = ghostship_data_store::tests::fixture(&library);
        library
            .finish_launch_session(
                &seal.session.id,
                crate::LaunchSessionOutcome::Succeeded,
                Some(0),
                None,
            )
            .unwrap();
        library.register_source(&seal.source).unwrap();
        library.register_install(&seal.install, true).unwrap();
        let active = InstallRecord {
            id: "newer".into(),
            version: "3.0.0".into(),
            path: library.versions_dir().join("ghostship/newer"),
            ..seal.install.clone()
        };
        library.register_install(&active, true).unwrap();
        let staged = InstallRecord {
            id: "staged".into(),
            path: library.versions_dir().join("ghostship/staged"),
            ..active.clone()
        };
        library.register_install(&staged, false).unwrap();
        let status = library
            .status("ghostship", crate::ReleaseChannel::Stable)
            .unwrap();
        let backup = crate::BackupRecord {
            id: uuid::Uuid::new_v4().to_string(),
            port_id: "ghostship".into(),
            path: library.backups_dir().join("ghostship/inert"),
            created_at: 1,
            file_count: 0,
            size: 0,
            sha256: "a".repeat(64),
        };
        let plan = crate::GhostshipRecoveryPlan {
            format_version: 1,
            library_root: library.root().into(),
            backup: backup.clone(),
            qualification_sha256: "b".repeat(64),
            legacy_install: seal.install.clone(),
            active_install: active,
            staged_install: status.staged,
            source: seal.source,
            channel: status.channel,
            update_policy: status.update_policy,
            canonical_data: seal.data.clone(),
            active_install_tree: seal.data.clone(),
            legacy_install_tree: seal.data.clone(),
            snapshot_data: seal.data.clone(),
            required_bytes: 0,
            plan_sha256: "c".repeat(64),
        };
        let intent = GhostshipRecoveryIntent {
            format_version: 1,
            plan,
            canonical_safety: Some(backup),
            runtime_data: seal.data.clone(),
            derivative_tree: Some(seal.data),
        };
        let mut operation = LifecycleOperation::new(
            uuid::Uuid::new_v4().to_string(),
            LifecycleOperationKind::GhostshipRecovery,
            "ghostship",
        );
        operation.phase = LifecyclePhase::PayloadPublished;
        operation.install = Some(InstallRecord {
            id: operation.id.clone(),
            path: library.versions_dir().join("ghostship/derivative"),
            ..seal.install
        });
        operation.ghostship_recovery = Some(intent.clone());
        OperationStore::new(library.clone())
            .put(&mut operation)
            .unwrap();
        (temporary, library, operation, intent)
    }

    #[test]
    fn ghostship_derivative_install_payload_roundtrips_without_relaxing_family_ownership() {
        let (_temporary, library, operation, intent) = fixture();
        let store = OperationStore::new(library.clone());
        let retained = store.get(&operation.id).unwrap().unwrap();
        assert_eq!(
            serde_json::to_value(&retained.install).unwrap(),
            serde_json::to_value(&operation.install).unwrap()
        );
        assert_eq!(retained.phase, LifecyclePhase::PayloadPublished);
        assert_eq!(
            serde_json::to_value(retained.ghostship_recovery.as_ref().unwrap()).unwrap(),
            serde_json::to_value(&intent).unwrap()
        );
        for missing_or_foreign in [false, true] {
            let mut malformed = operation.clone();
            if missing_or_foreign {
                malformed.kind = LifecycleOperationKind::Restore;
            } else {
                malformed.ghostship_recovery = None;
            }
            assert!(store.put(&mut malformed).is_err());
            let unchanged = store.get(&operation.id).unwrap().unwrap();
            assert_eq!(format!("{unchanged:?}"), format!("{retained:?}"));
        }
    }

    #[test]
    fn ghostship_recovery_commit_preserves_retained_and_staged_records_atomically() {
        let (_temporary, library, operation, intent) = fixture();
        library
            .commit_ghostship_recovery(&operation, &intent)
            .unwrap();
        let status = library.status("ghostship", intent.plan.channel).unwrap();
        assert_eq!(status.active.unwrap().id, operation.id);
        assert_eq!(status.previous.unwrap().id, intent.plan.active_install.id);
        assert_eq!(
            status.staged.unwrap().id,
            intent.plan.staged_install.as_ref().unwrap().id
        );
        assert_eq!(
            serde_json::to_value(
                Library::install_by_id(
                    &library.connection().unwrap(),
                    Some(&intent.plan.legacy_install.id)
                )
                .unwrap()
            )
            .unwrap(),
            serde_json::to_value(Some(&intent.plan.legacy_install)).unwrap()
        );
        assert_eq!(
            OperationStore::new(library.clone())
                .get(&operation.id)
                .unwrap()
                .unwrap()
                .phase,
            LifecyclePhase::MetadataCommitted
        );
        assert!(
            library
                .commit_ghostship_recovery(&operation, &intent)
                .is_err()
        );
    }

    #[test]
    fn ghostship_recovery_journal_cas_failure_rolls_back_install_pointers_and_safety_admission() {
        let (_temporary, library, operation, mut intent) = fixture();
        // Fail the final journal predicate after the transaction has attempted
        // installation, pointer and safety-admission writes.
        intent.runtime_data.directories.push("changed".into());
        assert!(
            library
                .commit_ghostship_recovery(&operation, &intent)
                .is_err()
        );
        let connection = library.connection().unwrap();
        assert!(
            Library::install_by_id(&connection, Some(&operation.id))
                .unwrap()
                .is_none()
        );
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM ghostship_runtime_safety", [], |row| {
                    row.get::<_, u64>(0)
                })
                .unwrap(),
            0
        );
        let status = library.status("ghostship", intent.plan.channel).unwrap();
        assert_eq!(status.active.unwrap().id, intent.plan.active_install.id);
        assert_eq!(status.previous.unwrap().id, intent.plan.legacy_install.id);
        assert_eq!(
            OperationStore::new(library.clone())
                .get(&operation.id)
                .unwrap()
                .unwrap()
                .phase,
            LifecyclePhase::PayloadPublished
        );
    }

    #[test]
    fn ghostship_recovery_commit_rejects_changed_source_and_complete_staged_tuple() {
        for change in [
            "source",
            "extra-staged",
            "retained-install",
            "overlapping-journal",
        ] {
            let (_temporary, library, operation, intent) = fixture();
            let connection = library.connection().unwrap();
            match change {
                "source" => {
                    connection.execute("UPDATE sources SET updated_at=updated_at+1 WHERE profile_id='ghostship-source'", []).unwrap();
                }
                "extra-staged" => {
                    let extra = InstallRecord {
                        id: "extra".into(),
                        path: library.versions_dir().join("ghostship/extra"),
                        ..intent.plan.active_install.clone()
                    };
                    Library::write_install(&connection, &extra, true).unwrap();
                }
                "retained-install" => {
                    connection
                        .execute(
                            "UPDATE installs SET verified=0 WHERE id=?1",
                            [&intent.plan.legacy_install.id],
                        )
                        .unwrap();
                }
                _ => {
                    let mut other = LifecycleOperation::new(
                        "other",
                        LifecycleOperationKind::Restore,
                        "ghostship",
                    );
                    OperationStore::new(library.clone())
                        .put(&mut other)
                        .unwrap();
                }
            }
            assert!(
                library
                    .commit_ghostship_recovery(&operation, &intent)
                    .is_err(),
                "{change}"
            );
            assert!(
                Library::install_by_id(&connection, Some(&operation.id))
                    .unwrap()
                    .is_none()
            );
        }
    }

    #[test]
    fn ghostship_recovery_pending_intent_fences_normal_writers_and_other_recovery() {
        let (_temporary, library, operation, _intent) = fixture();
        assert!(library.try_lock_port("ghostship", "install").is_err());
        assert!(
            library
                .try_lock_port_for_launch_recovery("ghostship", "foreign")
                .is_err()
        );
        assert!(
            library
                .try_lock_port_for_ghostship_recovery("foreign")
                .is_err()
        );
        assert!(
            library
                .try_lock_port_for_ghostship_recovery(&operation.id)
                .is_ok()
        );
        assert!(library.try_lock_port("another-port", "install").is_ok());
        let service = PortcoveService::new_read_only(library.clone()).unwrap();
        assert!(service.synchronize_restored_user_data("ghostship").is_err());
        assert!(
            service
                .restore_user_data_to(
                    service.catalog.port("ghostship").unwrap(),
                    &library.versions_dir().join("ghostship/inert")
                )
                .is_err()
        );
        library
            .connection()
            .unwrap()
            .execute(
                "UPDATE lifecycle_operations SET port_id='another-port' WHERE id=?1",
                [&operation.id],
            )
            .unwrap();
        assert!(OperationStore::new(library).get(&operation.id).is_err());
    }

    #[test]
    fn ghostship_recovery_projection_uses_portable_case_identity_and_preserves_absence() {
        let temporary = tempfile::tempdir().unwrap();
        fs::create_dir_all(temporary.path().join("Mods/empty")).unwrap();
        fs::create_dir_all(temporary.path().join("mods-extra")).unwrap();
        fs::write(temporary.path().join("Mods/save"), b"keep").unwrap();
        fs::write(temporary.path().join("mods-extra/immutable"), b"code").unwrap();
        let tree = ghostship_data_store::reviewed_data(temporary.path()).unwrap();
        let selected = selected_tree(&tree, &["mods".into(), "absent".into()], true).unwrap();
        assert_eq!(selected.files.len(), 1);
        assert_eq!(selected.files[0].relative_path, Path::new("Mods/save"));
        assert!(selected.directories.contains(&PathBuf::from("Mods/empty")));
        let immutable = selected_tree(&tree, &["mods".into()], false).unwrap();
        assert_eq!(immutable.files.len(), 1);
        assert!(!immutable.directories.contains(&PathBuf::from("Mods")));
        ghostship_data_store::validate_data_plan(&selected).unwrap();
    }
}
