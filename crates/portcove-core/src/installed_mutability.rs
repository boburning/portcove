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
    if operational_compatibility(retained) != operational_compatibility(&current) {
        let mut without_settings_drift = current.clone();
        without_settings_drift
            .game_settings
            .clone_from(&retained.game_settings);
        if operational_compatibility(retained) != operational_compatibility(&without_settings_drift)
        {
            return Ok(retained.clone());
        }
        // Optional settings do not rebind an installed definition. Preserve
        // its complete authority, then independently apply only the existing
        // exact-artifact correction below, with all manifest/shape checks.
        // In particular, current-only path additions are not borrowed here.
        current = retained.clone();
    }
    let shipwright = shipwright_windows_cwd_persistence(retained, install, platform);
    if shipwright {
        for path in ["Save", "SoHTimeSplitData.json"] {
            if !current
                .persistent_paths
                .iter()
                .any(|existing| existing == path)
            {
                current.persistent_paths.push(path.into());
            }
        }
        if !current
            .runtime_mutable_paths
            .iter()
            .any(|path| path == "logs/Ship of Harkinian.log")
        {
            current
                .runtime_mutable_paths
                .push("logs/Ship of Harkinian.log".into());
        }
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
    if shipwright {
        // Path mutability is prefix-based. These two known leaves must never
        // authorize directories or aliases, including canonical saved data.
        installer.require_mutability_file_shapes(
            install,
            &candidate_qualification,
            &["SoHTimeSplitData.json"],
            &["logs/Ship of Harkinian.log"],
        )?;
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

/// Compare the retained execution/authority contract, excluding only display
/// metadata (including the legacy support tier, qualification and maintenance observations) and the two
/// additive path lists proved separately above. Release
/// locations, channel/platform policy, source/preparation and launch
/// inputs remain operational. Exhaustive field handling makes schema additions
/// require a classification here rather than silently expanding an allowlist.
fn operational_compatibility(port: &PortDefinition) -> serde_json::Value {
    let PortDefinition {
        id,
        name: _,
        summary: _,
        project_url: _,
        support_tier: _,
        channels,
        platforms,
        automated_tested_platforms: _,
        manually_validated_platforms: _,
        adapter,
        release,
        bundled_runtime,
        source_profile,
        bios_source_profile,
        executable_hints,
        persistent_paths: _,
        persistent_file_patterns,
        runtime_mutable_paths: _,
        runtime_mutable_file_patterns,
        windows_runtime_path_policy,
        windows_temp_directory,
        portable_marker,
        n64_windows_initial_d3d12,
        n64_runtime_at_executable_parent,
        managed_initialization,
        runtime_data_policy,
        mod_package_policy,
        game_settings,
        managed_shared_preferences,
        managed_shared_preferences_save_id,
        source_environment,
        user_data_environment,
        launch_environment,
        launch_arguments,
        runtime_subdirectory,
        runtime_source_filename,
        runtime_source_materialization,
        runtime_source_hashes,
        runtime_source_set,
        launch_from_install_root,
        setup_executable_hints,
        setup_arguments,
        setup_marker,
        setup_output_paths,
        upstream_status: _,
        presentation: _,
    } = port;
    serde_json::json!({
        "id": id,
        "channels": channels,
        "platforms": platforms,
        "adapter": adapter,
        "release": release,
        "bundled_runtime": bundled_runtime,
        "source_profile": source_profile,
        "bios_source_profile": bios_source_profile,
        "executable_hints": executable_hints,
        "persistent_file_patterns": persistent_file_patterns,
        "runtime_mutable_file_patterns": runtime_mutable_file_patterns,
        "windows_runtime_path_policy": windows_runtime_path_policy,
        "windows_temp_directory": windows_temp_directory,
        "portable_marker": portable_marker,
        "n64_windows_initial_d3d12": n64_windows_initial_d3d12,
        "n64_runtime_at_executable_parent": n64_runtime_at_executable_parent,
        "managed_initialization": managed_initialization,
        "runtime_data_policy": runtime_data_policy,
        "mod_package_policy": mod_package_policy,
        "game_settings": game_settings,
        "managed_shared_preferences": managed_shared_preferences,
        "managed_shared_preferences_save_id": managed_shared_preferences_save_id,
        "source_environment": source_environment,
        "user_data_environment": user_data_environment,
        "launch_environment": launch_environment,
        "launch_arguments": launch_arguments,
        "runtime_subdirectory": runtime_subdirectory,
        "runtime_source_filename": runtime_source_filename,
        "runtime_source_materialization": runtime_source_materialization,
        "runtime_source_hashes": runtime_source_hashes,
        "runtime_source_set": runtime_source_set,
        "launch_from_install_root": launch_from_install_root,
        "setup_executable_hints": setup_executable_hints,
        "setup_arguments": setup_arguments,
        "setup_marker": setup_marker,
        "setup_output_paths": setup_output_paths,
    })
}
