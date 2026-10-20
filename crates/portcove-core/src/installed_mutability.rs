//! Checked runtime mutability shared by service operations and transfer verification.
//! This interpretation never rewrites the retained catalog or manifest.

use crate::{InstallQualification, InstallRecord, Installer, Platform, PortDefinition, Result};

pub(crate) fn checked_port(
    installer: &Installer,
    install: &InstallRecord,
    retained: &PortDefinition,
    current: &PortDefinition,
    platform: Platform,
) -> Result<PortDefinition> {
    let mut current = current.clone();
    if shipwright_windows_cwd_persistence(retained, install, platform)
        && !current.persistent_paths.iter().any(|path| path == "Save")
    {
        current.persistent_paths.push("Save".into());
    }
    let mut retained_baseline = retained.clone();
    let mut current_baseline = current.clone();
    retained_baseline.persistent_paths.clear();
    retained_baseline.runtime_mutable_paths.clear();
    current_baseline.persistent_paths.clear();
    current_baseline.runtime_mutable_paths.clear();
    if serde_json::to_value(&retained_baseline)? != serde_json::to_value(&current_baseline)? {
        return Ok(retained.clone());
    }
    if !retained
        .persistent_paths
        .iter()
        .all(|path| current.persistent_paths.contains(path))
        || !retained
            .runtime_mutable_paths
            .iter()
            .all(|path| current.runtime_mutable_paths.contains(path))
    {
        return Ok(retained.clone());
    }
    let original = InstallQualification::from_port(retained, platform)?;
    let mut candidate = retained.clone();
    candidate
        .persistent_paths
        .clone_from(&current.persistent_paths);
    candidate
        .runtime_mutable_paths
        .clone_from(&current.runtime_mutable_paths);
    let candidate_qualification = InstallQualification::from_port(&candidate, platform)?;
    if !installer.permits_additive_mutability(install, &original, &candidate_qualification)? {
        return Ok(retained.clone());
    }
    Ok(candidate)
}

pub(crate) fn shipwright_windows_cwd_persistence(
    port: &PortDefinition,
    install: &InstallRecord,
    platform: Platform,
) -> bool {
    // Official 9.3.1 portable Win64 uses CWD/Save, not SHIP_HOME. Neither a
    // future version nor another Libultraship payload inherits this evidence.
    platform == Platform::WindowsX86_64
        && port.id == "shipwright"
        && install.port_id == port.id
        && port.adapter == crate::AdapterKind::LibultrashipPortable
        && port.user_data_environment.is_none()
        && install.version == "9.3.1"
        && install.artifact.asset_name == "SoH-Dewey-Bravo-Win64.zip"
        && install.artifact.size == 72_980_600
        && install.artifact.sha256
            == "429292a0bfbdfcda283b33c1538ecdc49163b9ed53e8702cac80b2489d9fe26c"
}
