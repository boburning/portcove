use std::fs;

use crate::{
    InstallRecord, Installer, PortcoveError, PortcoveService, Result,
    operation::{LifecycleOperation, LifecycleOperationKind, LifecyclePhase, OperationStore},
    service::{RemovalOperation, RemovalPhase, RestorePhase, copy_tree},
};

pub(crate) fn recover_published_install(
    service: &PortcoveService,
    store: &OperationStore,
    operation: &mut LifecycleOperation,
) -> Result<()> {
    // Recovery holds the journal owner's lock, not a lock inferred from its payload.
    // Verify that authority before publishing, registering, or cleaning any tree.
    if let Some(install) = &operation.install
        && install.port_id != operation.port_id
    {
        return Err(PortcoveError::state(
            "publication install owner differs from its journal owner",
        ));
    }
    if let (Some(install), Some(destination)) = (&operation.install, &operation.paths.final_path)
        && destination != &install.path
    {
        return Err(PortcoveError::state(
            "publication install destination differs from its journal destination",
        ));
    }
    if matches!(
        operation.kind,
        LifecycleOperationKind::Install | LifecycleOperationKind::Adopt
    ) && operation.preparation.is_some()
    {
        return Err(PortcoveError::state(
            "publication operation kind does not own its preparation payload",
        ));
    }
    if matches!(
        operation.kind,
        LifecycleOperationKind::Install | LifecycleOperationKind::Adopt
    ) && (operation.relocation.is_some()
        || operation.source_import.is_some()
        || !operation.original_paths.is_empty()
        || operation.paths.quarantine.is_some())
    {
        return Err(PortcoveError::state(
            "publication journal contains another lifecycle family's intent",
        ));
    }
    if operation.phase == LifecyclePhase::CleanupPending && operation.install.is_none() {
        return crate::cancellation::discard_private_install_with_faults(
            &service.library,
            operation,
            service.lifecycle_faults(),
        );
    }
    if operation.phase == LifecyclePhase::Preparing {
        return Err(PortcoveError::state(
            "private preparation was interrupted before validation",
        ));
    }
    let install = operation.install.clone().ok_or_else(|| {
        PortcoveError::state("recoverable publication is missing its install record")
    })?;
    let staging = operation.paths.staging.clone().ok_or_else(|| {
        PortcoveError::state("recoverable publication is missing its staging path")
    })?;
    let payload = staging.join("payload");
    crate::output_root::validate_staging_path(
        &service.library,
        &operation.port_id,
        &operation.id,
        &staging,
    )?;
    if operation.phase == LifecyclePhase::Prepared {
        match (payload.exists(), install.path.exists()) {
            (true, false) => {
                let staged = InstallRecord {
                    path: payload.clone(),
                    ..install.clone()
                };
                if !Installer::new(service.library.clone())?
                    .verify(&staged)?
                    .valid
                {
                    return Err(PortcoveError::verification(
                        "prepared payload no longer matches its manifest",
                    ));
                }
                require_install_publication_authority(service, operation, &staged)?;
                fs::create_dir_all(
                    install
                        .path
                        .parent()
                        .ok_or_else(|| PortcoveError::state("install destination has no parent"))?,
                )?;
                crate::durability::rename_noreplace(&payload, &install.path)?;
            }
            (false, true) => {}
            (true, true) => {
                return Err(PortcoveError::conflict(
                    "both prepared and published payloads exist; refusing automatic repair",
                ));
            }
            (false, false) => {
                return Err(PortcoveError::state(
                    "both prepared and published payloads are missing",
                ));
            }
        }
        operation.phase = LifecyclePhase::PayloadPublished;
        operation.last_error = None;
        store.put(operation)?;
        if operation.kind == LifecycleOperationKind::Prepare {
            service.check_lifecycle_fault(
                crate::operation::LifecycleFaultPoint::PreparationPublished,
            )?;
        }
    }
    if operation.phase == LifecyclePhase::PayloadPublished {
        if !Installer::new(service.library.clone())?
            .verify(&install)?
            .valid
        {
            return Err(PortcoveError::verification(
                "published payload no longer matches its manifest",
            ));
        }
        require_install_publication_authority(service, operation, &install)?;
        if operation.kind == LifecycleOperationKind::Prepare {
            let plan = operation.preparation.as_ref().ok_or_else(|| {
                PortcoveError::state("prepared publication is missing its reviewed inputs")
            })?;
            service
                .library
                .register_prepared_install(&install, &plan.inputs.install.id)?;
        } else {
            service
                .library
                .register_install(&install, operation.activate)?;
        }
        operation.phase = LifecyclePhase::MetadataCommitted;
        operation.last_error = None;
        store.put(operation)?;
        if operation.kind == LifecycleOperationKind::Prepare {
            service.check_lifecycle_fault(
                crate::operation::LifecycleFaultPoint::PreparationRegistered,
            )?;
        }
    }
    if matches!(
        operation.phase,
        LifecyclePhase::MetadataCommitted | LifecyclePhase::CleanupPending
    ) {
        if operation.kind == LifecycleOperationKind::Adopt {
            let staged_user = staging.join("user");
            if staged_user.exists() {
                copy_tree(&staged_user, &service.library.user_dir(&operation.port_id))?;
            }
        }
        if staging.exists() {
            fs::remove_dir_all(&staging)?;
        }
        store.remove(&operation.id)?;
    }
    Ok(())
}

fn require_install_publication_authority(
    service: &PortcoveService,
    operation: &LifecycleOperation,
    install: &InstallRecord,
) -> Result<()> {
    if !matches!(
        operation.kind,
        LifecycleOperationKind::Install
            | LifecycleOperationKind::Adopt
            | LifecycleOperationKind::Prepare
    ) {
        return Ok(());
    }
    if let Some(catalog) = Installer::new(service.library.clone())?.retained_catalog(install)? {
        let port = catalog.port(&install.port_id)?;
        if operation.kind == LifecycleOperationKind::Prepare
            && !catalog
                .definition_selection(&install.port_id)
                .is_some_and(|identity| {
                    crate::definition_acquisition::restricted_grant(&identity.grant_id)
                })
        {
            return Ok(());
        }
        if operation.kind == LifecycleOperationKind::Adopt {
            service.require_definition_adoption(&catalog, port)?;
        }
        service.require_definition_operation(
            &catalog,
            port,
            crate::definition_eligibility::DefinitionOperationContext::observed(
                if operation.kind == LifecycleOperationKind::Prepare {
                    crate::DefinitionOperation::Prepare
                } else {
                    crate::DefinitionOperation::Install
                },
                false,
                true,
            ),
        )?;
    }
    Ok(())
}

pub(crate) fn recover_removal(
    service: &PortcoveService,
    store: &OperationStore,
    operation: &mut LifecycleOperation,
) -> Result<()> {
    let mut removal = RemovalOperation::decode(&service.library, operation)?;
    if removal.phase == RemovalPhase::Quarantining {
        if operation.original_paths.is_empty() {
            store.remove(&operation.id)?;
            return Ok(());
        }
        for paths in removal.paths(&service.library)? {
            match (paths.live.exists(), paths.quarantined.exists()) {
                (true, false) => {
                    if let Some(parent) = paths.quarantined.parent() {
                        fs::create_dir_all(parent)?;
                    }
                    crate::durability::rename_noreplace(&paths.live, &paths.quarantined)?;
                }
                (false, true) => {}
                (true, true) => {
                    return Err(PortcoveError::conflict(
                        "both live and quarantined removal paths exist",
                    ));
                }
                (false, false) => {
                    return Err(PortcoveError::state(
                        "both live and quarantined removal paths are missing",
                    ));
                }
            }
        }
        removal.advance(RemovalPhase::Quarantined, operation, store)?;
    }
    if removal.phase == RemovalPhase::Quarantined {
        service.library.remove_port(&operation.port_id)?;
        removal.advance(RemovalPhase::Committed, operation, store)?;
    }
    if matches!(
        removal.phase,
        RemovalPhase::Committed | RemovalPhase::CleanupPending
    ) {
        let cleanup_roots = removal
            .paths(&service.library)?
            .into_iter()
            .map(|paths| paths.cleanup_root)
            .collect::<std::collections::BTreeSet<_>>();
        for cleanup_root in cleanup_roots {
            if cleanup_root.exists() {
                fs::remove_dir_all(cleanup_root)?;
            }
        }
        store.remove(&operation.id)?;
    }
    Ok(())
}

pub(crate) fn recover_restore(
    service: &PortcoveService,
    store: &OperationStore,
    operation: &mut LifecycleOperation,
) -> Result<()> {
    let mut restore = service.validate_restore_operation(operation)?;
    if restore.phase == RestorePhase::Unverified {
        return Err(PortcoveError::state(
            "restore preparation was interrupted before backup verification",
        ));
    }
    let recovery_root = restore.recovery_root.clone();
    let staged = restore.staged_data.clone();
    let user_root = restore.user_root.clone();
    let previous = restore.previous_data.clone();
    if restore.phase == RestorePhase::ReadyToPublish {
        if restore.replaces_existing_data {
            match (staged.exists(), user_root.exists(), previous.exists()) {
                (true, true, false) => {
                    fs::rename(&user_root, &previous)?;
                    fs::rename(&staged, &user_root)?;
                }
                (true, false, true) => fs::rename(&staged, &user_root)?,
                (false, true, true) => {}
                _ => {
                    return Err(PortcoveError::conflict(
                        "restore publication paths are ambiguous; refusing automatic repair",
                    ));
                }
            }
        } else {
            match (staged.exists(), user_root.exists()) {
                (true, false) => fs::rename(&staged, &user_root)?,
                (false, true) => {}
                _ => {
                    return Err(PortcoveError::conflict(
                        "restore publication paths are ambiguous; refusing automatic repair",
                    ));
                }
            }
        }
        restore.advance(RestorePhase::Published, operation, store)?;
    }
    if matches!(
        restore.phase,
        RestorePhase::Published | RestorePhase::Committed | RestorePhase::CleanupPending
    ) {
        service.synchronize_restored_user_data(&operation.port_id)?;
    }
    if restore.phase == RestorePhase::Published {
        restore.advance(RestorePhase::Committed, operation, store)?;
    }
    if matches!(
        restore.phase,
        RestorePhase::Committed | RestorePhase::CleanupPending
    ) {
        if previous.exists() {
            fs::remove_dir_all(&previous)?;
        }
        if recovery_root.exists() {
            fs::remove_dir_all(&recovery_root)?;
        }
        store.remove(&operation.id)?;
    }
    Ok(())
}

pub(crate) fn recover_backup_deletion(
    service: &PortcoveService,
    store: &OperationStore,
    operation: &mut LifecycleOperation,
) -> Result<()> {
    let mut deletion = service.validate_backup_deletion_operation(operation)?;
    if deletion.phase == crate::service::BackupDeletionPhase::Unconfirmed {
        return Err(PortcoveError::state(
            "backup deletion preparation was interrupted before authorization",
        ));
    }
    if deletion.phase == crate::service::BackupDeletionPhase::Authorized {
        match (
            path_exists(&deletion.original)?,
            path_exists(&deletion.quarantine)?,
        ) {
            (true, false) => {
                service.validate_backup_directory_identity(
                    &deletion.original,
                    &operation.port_id,
                    &deletion.backup_id,
                )?;
                crate::durability::rename_noreplace(&deletion.original, &deletion.quarantine)?;
            }
            (false, true) => service.validate_backup_directory_identity(
                &deletion.quarantine,
                &operation.port_id,
                &deletion.backup_id,
            )?,
            (true, true) => {
                return Err(PortcoveError::conflict(
                    "both visible and quarantined backup paths exist; refusing automatic deletion",
                ));
            }
            (false, false) => {
                return Err(PortcoveError::state(
                    "both visible and quarantined backup paths are missing; deletion outcome is ambiguous",
                ));
            }
        }
        deletion.advance(
            crate::service::BackupDeletionPhase::Quarantined,
            operation,
            store,
        )?;
    }
    if deletion.phase == crate::service::BackupDeletionPhase::Quarantined {
        if path_exists(&deletion.original)? {
            return Err(PortcoveError::conflict(
                "a visible backup reappeared during deletion recovery; refusing automatic deletion",
            ));
        }
        if path_exists(&deletion.quarantine)? {
            fs::remove_dir_all(&deletion.quarantine)?;
        }
        deletion.advance(
            crate::service::BackupDeletionPhase::Deleted,
            operation,
            store,
        )?;
    }
    if matches!(
        deletion.phase,
        crate::service::BackupDeletionPhase::Deleted
            | crate::service::BackupDeletionPhase::CleanupPending
    ) {
        if path_exists(&deletion.original)? {
            return Err(PortcoveError::conflict(
                "a visible backup exists after deletion was committed; refusing to reinterpret it",
            ));
        }
        if path_exists(&deletion.quarantine)? {
            fs::remove_dir_all(&deletion.quarantine)?;
        }
        store.remove(&operation.id)?;
    }
    Ok(())
}

fn path_exists(path: &std::path::Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ActivationPhase {
    Preparing,
    Committed,
}

// Interpret the released activation envelope once for normal execution and recovery.
// This family does not grant consent, bypass locks or replace filesystem verification.
pub(crate) struct ActivationOperation {
    id: String,
    created_at: i64,
    install: InstallRecord,
    phase: ActivationPhase,
}

impl ActivationOperation {
    pub(crate) fn decode(
        service: &PortcoveService,
        operation: &LifecycleOperation,
    ) -> Result<Self> {
        if operation.kind != LifecycleOperationKind::Activate
            || operation.activate
            || operation.relocation.is_some()
            || operation.source_import.is_some()
            || operation.preparation.is_some()
            || operation.preparation_process_quiesced.is_some()
            || operation.paths.staging.is_some()
            || operation.paths.final_path.is_some()
            || operation.paths.quarantine.is_some()
            || !operation.original_paths.is_empty()
        {
            return Err(PortcoveError::state(
                "activation journal has an incompatible lifecycle envelope",
            ));
        }
        let install = operation.install.as_ref().ok_or_else(|| {
            PortcoveError::state("recoverable activation is missing its staged install identity")
        })?;
        if install.port_id != operation.port_id {
            return Err(PortcoveError::state(
                "activation journal owner differs from its install identity",
            ));
        }
        let phase = match operation.phase {
            LifecyclePhase::Preparing => ActivationPhase::Preparing,
            LifecyclePhase::MetadataCommitted => ActivationPhase::Committed,
            _ => {
                return Err(PortcoveError::state(
                    "activation journal has an incompatible stored phase",
                ));
            }
        };
        if phase == ActivationPhase::Preparing {
            let status = service
                .library
                .status(&operation.port_id, install.channel)?;
            let current = status
                .active
                .iter()
                .chain(status.staged.iter())
                .find(|current| current.id == install.id)
                .ok_or_else(|| {
                    PortcoveError::conflict(
                        "the staged install changed while activation was interrupted",
                    )
                })?;
            if !same_activation_install(current, install) {
                return Err(PortcoveError::conflict(
                    "activation journal differs from the registered install identity",
                ));
            }
        }
        Ok(Self {
            id: operation.id.clone(),
            created_at: operation.created_at,
            install: install.clone(),
            phase,
        })
    }

    pub(crate) fn is_preparing(&self) -> bool {
        self.phase == ActivationPhase::Preparing
    }

    pub(crate) fn prepare_commit<'a>(
        &'a mut self,
        service: &PortcoveService,
        operation: &'a mut LifecycleOperation,
    ) -> Result<ActivationCommit<'a>> {
        let current = Self::decode(service, operation)?;
        if self.phase != ActivationPhase::Preparing
            || current.phase != self.phase
            || current.id != self.id
            || current.created_at != self.created_at
            || !same_activation_install(&current.install, &self.install)
        {
            return Err(PortcoveError::state(
                "activation journal changed before its checked commit transition",
            ));
        }
        Ok(ActivationCommit {
            activation: self,
            operation,
        })
    }
}

// Borrow both identities across the metadata transaction: consumers cannot change
// the checked envelope before persisting the committed phase.
pub(crate) struct ActivationCommit<'a> {
    activation: &'a mut ActivationOperation,
    operation: &'a mut LifecycleOperation,
}

impl ActivationCommit<'_> {
    pub(crate) fn persist(self, store: &OperationStore) -> Result<()> {
        self.operation.phase = LifecyclePhase::MetadataCommitted;
        self.operation.last_error = None;
        // No fallible read after metadata commit; retain committed error handling
        // even if the existing journal write fails.
        self.activation.phase = ActivationPhase::Committed;
        store.put(self.operation)
    }
}

fn same_activation_install(left: &InstallRecord, right: &InstallRecord) -> bool {
    // verified/staged are mutable read-model flags, not durable install identity.
    left.id == right.id
        && left.port_id == right.port_id
        && left.version == right.version
        && left.path == right.path
        && left.channel == right.channel
        && left.installed_at == right.installed_at
        && left.artifact == right.artifact
        && left.runtime == right.runtime
        && left.manifest_sha256 == right.manifest_sha256
        && left.selected_executable == right.selected_executable
}

pub(crate) fn recover_activation(
    service: &PortcoveService,
    store: &OperationStore,
    operation: &mut LifecycleOperation,
) -> Result<()> {
    let mut activation = ActivationOperation::decode(service, operation)?;
    let install = activation.install.clone();
    if activation.is_preparing() {
        let port = service.installed_port(&install)?;
        let qualification = service.installed_mutability_qualification(&install)?;
        Installer::new(service.library.clone())?.verify_critical(&install, &qualification)?;
        let status = service
            .library
            .status(&operation.port_id, install.channel)?;
        if status.active.as_ref().map(|active| &active.id) != Some(&install.id) {
            if status.staged.as_ref().map(|staged| &staged.id) != Some(&install.id) {
                return Err(PortcoveError::conflict(
                    "the staged install changed while activation was interrupted",
                ));
            }
            let commit = activation.prepare_commit(service, operation)?;
            service.collect_active_user_data_if_launched(&install.port_id)?;
            service.restore_user_data_to(&port, &install.path)?;
            Installer::new(service.library.clone())?.verify_critical(&install, &qualification)?;
            service.library.activate_staged(&install.port_id)?;
            commit.persist(store)?;
        } else {
            activation
                .prepare_commit(service, operation)?
                .persist(store)?;
        }
    }
    if !activation.is_preparing() {
        store.remove(&operation.id)?;
    }
    Ok(())
}
