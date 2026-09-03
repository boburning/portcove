use std::fs;

use crate::{
    InstallRecord, Installer, PortcoveError, PortcoveService, Result,
    operation::{LifecycleOperation, LifecycleOperationKind, LifecyclePhase, OperationStore},
    service::copy_tree,
};

pub(crate) fn recover_published_install(
    service: &PortcoveService,
    store: &OperationStore,
    operation: &mut LifecycleOperation,
) -> Result<()> {
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
                fs::create_dir_all(
                    install
                        .path
                        .parent()
                        .ok_or_else(|| PortcoveError::state("install destination has no parent"))?,
                )?;
                fs::rename(&payload, &install.path)?;
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
        service
            .library
            .register_install(&install, operation.activate)?;
        operation.phase = LifecyclePhase::MetadataCommitted;
        operation.last_error = None;
        store.put(operation)?;
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

pub(crate) fn recover_removal(
    service: &PortcoveService,
    store: &OperationStore,
    operation: &mut LifecycleOperation,
) -> Result<()> {
    let quarantine = operation.paths.quarantine.clone().ok_or_else(|| {
        PortcoveError::state("recoverable removal is missing its quarantine path")
    })?;
    if operation.phase == LifecyclePhase::Preparing {
        if operation.original_paths.is_empty() {
            store.remove(&operation.id)?;
            return Ok(());
        }
        for path in &operation.original_paths {
            let relative = path
                .strip_prefix(service.library.versions_dir())
                .map_err(|_| {
                    PortcoveError::conflict("registered removal path is outside managed versions")
                })?;
            let quarantined = quarantine.join(relative);
            match (path.exists(), quarantined.exists()) {
                (true, false) => {
                    if let Some(parent) = quarantined.parent() {
                        fs::create_dir_all(parent)?;
                    }
                    fs::rename(path, &quarantined)?;
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
        operation.phase = LifecyclePhase::PayloadPublished;
        operation.last_error = None;
        store.put(operation)?;
    }
    if operation.phase == LifecyclePhase::PayloadPublished {
        service.library.remove_port(&operation.port_id)?;
        operation.phase = LifecyclePhase::MetadataCommitted;
        operation.last_error = None;
        store.put(operation)?;
    }
    if matches!(
        operation.phase,
        LifecyclePhase::MetadataCommitted | LifecyclePhase::CleanupPending
    ) {
        if quarantine.exists() {
            fs::remove_dir_all(&quarantine)?;
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
    if operation.phase == LifecyclePhase::Preparing {
        return Err(PortcoveError::state(
            "restore preparation was interrupted before backup verification",
        ));
    }
    let recovery_root =
        operation.paths.staging.clone().ok_or_else(|| {
            PortcoveError::state("recoverable restore is missing its recovery path")
        })?;
    let staged = recovery_root.join("staged-data");
    let user_root =
        operation.paths.final_path.clone().ok_or_else(|| {
            PortcoveError::state("recoverable restore is missing its user-data path")
        })?;
    let previous =
        operation.paths.quarantine.clone().ok_or_else(|| {
            PortcoveError::state("recoverable restore is missing its rollback path")
        })?;
    if operation.phase == LifecyclePhase::Prepared {
        if operation.activate {
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
        operation.phase = LifecyclePhase::PayloadPublished;
        operation.last_error = None;
        store.put(operation)?;
    }
    if matches!(
        operation.phase,
        LifecyclePhase::PayloadPublished
            | LifecyclePhase::MetadataCommitted
            | LifecyclePhase::CleanupPending
    ) {
        service.synchronize_restored_user_data(&operation.port_id)?;
    }
    if operation.phase == LifecyclePhase::PayloadPublished {
        operation.phase = LifecyclePhase::MetadataCommitted;
        operation.last_error = None;
        store.put(operation)?;
    }
    if matches!(
        operation.phase,
        LifecyclePhase::MetadataCommitted | LifecyclePhase::CleanupPending
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

pub(crate) fn recover_activation(
    service: &PortcoveService,
    store: &OperationStore,
    operation: &mut LifecycleOperation,
) -> Result<()> {
    let install = operation.install.clone().ok_or_else(|| {
        PortcoveError::state("recoverable activation is missing its staged install identity")
    })?;
    if operation.phase == LifecyclePhase::Preparing {
        Installer::new(service.library.clone())?.verify_critical(&install)?;
        let status = service
            .library
            .status(&operation.port_id, install.channel)?;
        if status.active.as_ref().map(|active| &active.id) != Some(&install.id) {
            if status.staged.as_ref().map(|staged| &staged.id) != Some(&install.id) {
                return Err(PortcoveError::conflict(
                    "the staged install changed while activation was interrupted",
                ));
            }
            service.collect_active_user_data_if_launched(&operation.port_id)?;
            service
                .restore_user_data_to(service.catalog().port(&operation.port_id)?, &install.path)?;
            service.library.activate_staged(&operation.port_id)?;
        }
        operation.phase = LifecyclePhase::MetadataCommitted;
        operation.last_error = None;
        store.put(operation)?;
    }
    if operation.phase == LifecyclePhase::MetadataCommitted {
        store.remove(&operation.id)?;
    }
    Ok(())
}
