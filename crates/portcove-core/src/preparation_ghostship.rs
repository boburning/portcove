//! Closed preparation interpretation for the reviewed Ghostship 2.0.0 package.
//! The admitted definition remains unchanged and independently hash-bound.

use crate::{
    AdapterKind, InstallRecord, Platform, PortDefinition, PortcoveError, Result,
    RuntimeSourceMaterialization, SourceRecord,
};

pub(super) const GENERATED: &str = "prepared-game-data/sm64.o2r";
pub(super) const ORIGINAL: &str = "baserom.us.z64";
pub(super) const EXECUTABLE_SHA256: &str =
    "2063529579d27d98953613147e0d53e2cde3ed4e783a8f2f51a43afbbd8b4c24";

pub(super) fn generated_path(root: &std::path::Path) -> std::path::PathBuf {
    // GENERATED is a portable manifest name. Native no-replace publication
    // passes an extended Windows path directly to MoveFileExW, which must not
    // receive the manifest's forward slash in its destination buffer.
    root.join("prepared-game-data").join("sm64.o2r")
}

pub(super) fn require_no_binary_importer(root: &std::path::Path) -> Result<()> {
    let path = root.join("default.sav");
    crate::path::refuse_symlink_ancestors(&path)?;
    match std::fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
        Ok(_) => Err(PortcoveError::conflict(
            "legacy runtime cannot consume an unqualified binary save importer; preserve default.sav and JSON saves for reviewed recovery",
        )),
    }
}

pub(super) fn require_discovery_layout(
    bundle: &crate::AdoptionCopyPlan,
    working: &crate::AdoptionCopyPlan,
) -> Result<()> {
    let is_rom = |path: &std::path::Path| {
        path.components().count() == 1
            && path.extension().is_some_and(|extension| extension == "z64")
    };
    let discovered = working
        .files
        .iter()
        .filter(|file| is_rom(&file.relative_path))
        .collect::<Vec<_>>();
    if bundle.files.iter().any(|file| is_rom(&file.relative_path))
        || discovered.len() != 1
        || discovered[0].relative_path != std::path::Path::new(ORIGINAL)
    {
        return Err(PortcoveError::verification(
            "legacy bootstrap requires exactly one verified CWD lowercase-z64 original and none in its executable bundle",
        ));
    }
    Ok(())
}

pub(super) fn execution_contract(
    port: &PortDefinition,
    install: &InstallRecord,
    host: Platform,
) -> Result<PortDefinition> {
    require_path(&install.path)?;
    if host != Platform::WindowsX86_64
        || port.id != "ghostship"
        || port.adapter != AdapterKind::LibultrashipPortable
        || port.source_profile.as_deref() != Some("ghostship-source")
        || install.port_id != port.id
        || install.version != "2.0.0"
        || install.artifact.asset_name != "Mary-Celeste-Alfa-Win64.zip"
        || install.artifact.sha256
            != "a49f4c791377fcc611264b8920f2c3254b3ab25747c2a59da9305c32f92a6d3f"
        || install.artifact.size != 21_561_620
        || !install
            .selected_executable
            .to_str()
            .is_some_and(|path| path.eq_ignore_ascii_case("Ghostship.exe"))
        || port.runtime_subdirectory.is_some()
        || !port.setup_output_paths.is_empty()
        || port.setup_marker.is_some()
        || !port.setup_executable_hints.is_empty()
        || !port.setup_arguments.is_empty()
        || !port.runtime_source_set.is_empty()
        || !port.persistent_file_patterns.is_empty()
        || !port.launch_arguments.is_empty()
    {
        return Err(PortcoveError::unsupported(
            "legacy bootstrap requires the exact reviewed Ghostship 2.0.0 Windows package and admitted source contract",
        ));
    }
    let mut execution = port.clone();
    execution.runtime_source_filename = Some(ORIGINAL.into());
    execution.runtime_source_materialization = Some(RuntimeSourceMaterialization::N64BigEndian);
    execution.setup_executable_hints = std::collections::BTreeMap::from([(
        host,
        vec![crate::path::unicode(
            &install.selected_executable,
            "legacy executable",
        )?],
    )]);
    execution.setup_marker = Some(GENERATED.into());
    execution.setup_output_paths = vec![GENERATED.into()];
    super::validate_output_contract(&execution)?;
    Ok(execution)
}

pub(super) fn require_path(path: &std::path::Path) -> Result<()> {
    // The exact extractor uses FindFirstFileA/PathFindExtensionA. It has no
    // reviewed Unicode or long-path contract; the copied ROM name is fixed.
    if !path
        .to_str()
        .is_some_and(|path| path.len() < 260 && path.bytes().all(|byte| (32..=126).contains(&byte)))
    {
        return Err(PortcoveError::unsupported(
            "Ghostship 2.0.0 requires a printable ASCII runtime path shorter than MAX_PATH",
        ));
    }
    Ok(())
}

pub(super) fn require_source(source: &SourceRecord) -> Result<()> {
    if source.profile_id != "ghostship-source"
        || source.size != 8_388_608
        || source.sha256 != "17ce077343c6133f8c9f2d6d6d9a4ab62c8cd2aa57c40aea1f490b4c8bb21d91"
        || source.storage_sha256 != source.sha256
        || source.storage_size != source.size
    {
        return Err(PortcoveError::source(
            "legacy bootstrap requires the reviewed exact Super Mario 64 USA big-endian original",
        ));
    }
    Ok(())
}

pub(super) fn validate_plan(
    plan: &super::PreparationPlan,
    port: &PortDefinition,
) -> Result<PortDefinition> {
    if plan.format_version != 2
        || plan.inputs.options.mode != super::PreparationMode::Ghostship200Legacy
        || plan.port_id != port.id
        || plan.inputs.options.target != plan.inputs.host
        || plan
            .inputs
            .setup_tool
            .as_ref()
            .is_none_or(|tool| tool.sha256 != EXECUTABLE_SHA256 || tool.size != 11_533_312)
        || plan.inputs.conversion_tool.is_some()
    {
        return Err(PortcoveError::verification(
            "legacy preparation plan has an invalid closed interpretation",
        ));
    }
    require_source(&plan.inputs.source)?;
    execution_contract(port, &plan.inputs.install, plan.inputs.host)
}

#[cfg(test)]
#[path = "preparation_ghostship_tests.rs"]
mod tests;
