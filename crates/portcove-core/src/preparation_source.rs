//! Immutable runtime originals share the existing install/preparation publisher.
use std::{cell::Cell, fs, path::Path};

use serde::{Deserialize, Serialize};

use crate::{
    AdapterKind, Catalog, InstallRecord, Installer, Library, Platform, PortDefinition,
    PortcoveError, PreparationMode, PreparationTool, Result, RuntimeSourceMaterialization,
    SourceRecord,
};

pub(crate) const RECEIPT: &str = ".portcove-source-preparation.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SourcePreparation {
    format_version: u32,
    pub(crate) source: SourceRecord,
    definition_sha256: String,
    pub(crate) conversion_tool: Option<PreparationTool>,
    host: Platform,
}

pub(crate) fn eligible(port: &PortDefinition) -> bool {
    if port.adapter != AdapterKind::StagedSourcePortable
        || port.release.provider == crate::ReleaseSource::UserPrepared
        || port.managed_initialization.is_some()
        || port.managed_shared_preferences.is_some()
        || port.runtime_data_policy.is_some()
        || port.mod_package_policy.is_some()
        || port.n64_runtime_at_executable_parent
        || port.runtime_subdirectory.is_some()
        || !port.persistent_file_patterns.is_empty()
        || !port.runtime_mutable_file_patterns.is_empty()
    {
        return false;
    }
    let outputs = outputs(port);
    !outputs.is_empty()
        && outputs.iter().all(|output| {
            !port
                .persistent_paths
                .iter()
                .chain(&port.runtime_mutable_paths)
                .any(|mutable| crate::runtime::overlaps(output, mutable))
        })
}

pub(crate) fn capacity(inputs: &SourcePreparation, port: &PortDefinition) -> Result<u64> {
    let mut bytes = inputs.source.size.max(inputs.source.storage_size);
    if port.runtime_source_materialization == Some(RuntimeSourceMaterialization::GamecubeIso) {
        bytes = bytes.max(crate::adapter::GAMECUBE_DISC_CAPACITY_BYTES);
    }
    bytes
        .checked_mul(2)
        .ok_or_else(|| PortcoveError::state("runtime source preparation capacity overflowed"))
}

pub(crate) fn outputs(port: &PortDefinition) -> Vec<String> {
    port.runtime_source_filename
        .iter()
        .cloned()
        .chain(
            port.runtime_source_set
                .iter()
                .map(|target| target.destination.clone()),
        )
        .collect()
}

fn definition(catalog: &Catalog, port: &PortDefinition) -> Result<String> {
    let profile = port
        .source_profile
        .as_deref()
        .ok_or_else(|| PortcoveError::state("runtime source preparation has no source profile"))?;
    Ok(crate::signed_catalog::digest(&serde_json::to_vec(&(
        port,
        catalog.source_profile(profile)?,
    ))?))
}

pub(crate) fn plan(
    catalog: &Catalog,
    port: &PortDefinition,
    source: &SourceRecord,
    host: Platform,
) -> Result<SourcePreparation> {
    if !eligible(port) || port.source_profile.as_deref() != Some(&source.profile_id) {
        return Err(PortcoveError::unsupported(
            "this definition has no source-only preparation contract",
        ));
    }
    crate::source_inspection::verify_registered(catalog, source)?;
    let program = match port.runtime_source_materialization {
        Some(RuntimeSourceMaterialization::PsxBinCue | RuntimeSourceMaterialization::PsxRawSet) => {
            Some(crate::adapter::resolve_chdman()?)
        }
        Some(RuntimeSourceMaterialization::GamecubeIso)
            if crate::adapter::gamecube_source_requires_conversion(&source.path) =>
        {
            Some(crate::adapter::resolve_dolphin_tool()?)
        }
        _ => None,
    };
    Ok(SourcePreparation {
        format_version: 1,
        source: source.clone(),
        definition_sha256: definition(catalog, port)?,
        conversion_tool: program
            .map(|program| super::tool_identity(program, crate::ChildProcessClass::HostTool))
            .transpose()?,
        host,
    })
}

fn same_source(left: &SourceRecord, right: &SourceRecord) -> bool {
    left.profile_id == right.profile_id
        && left.path == right.path
        && left.sha256 == right.sha256
        && left.size == right.size
        && left.storage_sha256 == right.storage_sha256
        && left.storage_size == right.storage_size
}

pub(crate) fn validate(
    library: &Library,
    catalog: &Catalog,
    port: &PortDefinition,
    install: &InstallRecord,
    source: Option<&SourceRecord>,
    expected_plan: Option<&super::PreparationPlan>,
) -> Result<()> {
    let installer = Installer::new(library.clone())?;
    if installer.retained_preparation_mode(install)? != Some(PreparationMode::SourceOnly) {
        return Err(PortcoveError::conflict(
            "review and prepare this installation's runtime originals",
        ));
    }
    let receipt: SourcePreparation =
        serde_json::from_slice(&installer.read_verified_member(install, RECEIPT, 1024 * 1024)?)?;
    if receipt.format_version != 1
        || receipt.host != Platform::current()?
        || receipt.definition_sha256 != definition(catalog, port)?
        || !source.is_some_and(|source| same_source(source, &receipt.source))
    {
        return Err(PortcoveError::conflict(
            "runtime source inputs changed; review and prepare game data again",
        ));
    }
    if let Some(plan) = expected_plan {
        let prepared: super::execution::PreparationReceipt = serde_json::from_slice(
            &installer.read_verified_member(install, super::RECEIPT_FILE, 1024 * 1024)?,
        )?;
        if !super::format_matches(plan)
            || plan.inputs.options.mode != PreparationMode::SourceOnly
            || prepared.format_version != 3
            || prepared.plan_sha256 != plan.plan_sha256
            || serde_json::to_value(&prepared.inputs)? != serde_json::to_value(&plan.inputs)?
            || receipt.definition_sha256 != plan.inputs.definition_sha256
            || !same_source(&receipt.source, &plan.inputs.source)
            || receipt.conversion_tool != plan.inputs.conversion_tool
        {
            return Err(PortcoveError::verification(
                "sealed source receipt differs from its reviewed preparation plan",
            ));
        }
    }
    Ok(())
}

pub(crate) fn sealed(library: &Library, port: &PortDefinition, root: &Path) -> Result<bool> {
    if !eligible(port) {
        return Ok(false);
    }
    let Some(install) = library
        .all_installs()?
        .into_iter()
        .find(|install| install.port_id == port.id && install.path == root)
    else {
        return Ok(false);
    };
    Ok(
        Installer::new(library.clone())?.retained_preparation_mode(&install)?
            == Some(PreparationMode::SourceOnly),
    )
}

/// The caller owns a private payload and joins this worker before publication or cleanup.
pub(crate) fn materialize(
    catalog: &Catalog,
    port: &PortDefinition,
    inputs: &SourcePreparation,
    payload: &Path,
    working: &Path,
    checkpoint: &dyn Fn() -> Result<()>,
    process_quiesced: &Cell<bool>,
) -> Result<()> {
    if inputs.format_version != 1
        || !eligible(port)
        || inputs.definition_sha256 != definition(catalog, port)?
        || inputs.host != Platform::current()?
    {
        return Err(PortcoveError::verification(
            "runtime source preparation identity changed",
        ));
    }
    crate::source_inspection::verify_registered_with_checkpoint(
        catalog,
        &inputs.source,
        checkpoint,
    )?;
    if working != payload {
        return Err(PortcoveError::unsupported(
            "source-only preparation requires install-root output ownership",
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
        .collect::<Result<std::collections::BTreeMap<_, _>>>()?;

    if let Some(tool) = &inputs.conversion_tool
        && super::tool_identity(tool.path.clone(), crate::ChildProcessClass::HostTool)? != *tool
    {
        return Err(PortcoveError::verification(
            "runtime source conversion tool changed",
        ));
    }
    for relative in outputs(port) {
        checkpoint()?;
        crate::archive::validate_relative_path(&relative, true)?;
        let target = working.join(&relative);
        if !target.starts_with(payload) {
            return Err(PortcoveError::verification(
                "runtime source escaped private staging",
            ));
        }
        crate::path::refuse_symlink_ancestors(&target)?;
        match fs::symlink_metadata(&target) {
            Ok(metadata) if metadata.is_dir() => fs::remove_dir_all(&target)?,
            Ok(metadata) if metadata.is_file() => fs::remove_file(&target)?,
            Ok(_) => {
                return Err(PortcoveError::verification(
                    "runtime source staging contains an unsupported entry",
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    if let Some(filename) = &port.runtime_source_filename {
        let destination = working.join(filename);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        if inputs.conversion_tool.is_some() {
            process_quiesced.set(false);
        }
        crate::adapter::prepare_admitted_runtime_source(
            &inputs.source,
            &destination,
            port.runtime_source_materialization
                .ok_or_else(|| PortcoveError::state("runtime source has no materialization"))?,
            &port.runtime_source_hashes,
            inputs
                .conversion_tool
                .as_ref()
                .map(|tool| tool.path.as_path()),
            checkpoint,
            crate::tool_process::ToolProcessObserver {
                diagnostics: None,
                quiesced: Some(&mut || {
                    process_quiesced.set(true);
                    Ok(())
                }),
            },
        )?;
    }
    for target in &port.runtime_source_set {
        checkpoint()?;
        let destination = working.join(&target.destination);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        crate::adapter::prepare_runtime_source_set_member(
            &inputs.source.path,
            &target.source_filenames,
            &destination,
            target.materialization,
            checkpoint,
        )?;
    }
    crate::source_inspection::verify_registered_with_checkpoint(
        catalog,
        &inputs.source,
        checkpoint,
    )?;
    // Only private, already reviewed copies can contain a previous receipt.
    let prior = payload.join(super::RECEIPT_FILE);
    if prior.exists() {
        fs::remove_file(prior)?;
    }
    crate::durability::write_bytes_atomically(
        &payload.join(RECEIPT),
        &serde_json::to_vec(inputs)?,
        true,
    )?;
    let mut owned = port.clone();
    owned.setup_output_paths = outputs(port);
    owned
        .setup_output_paths
        .extend(crate::adapter::generated_metadata(port)?);
    owned
        .setup_output_paths
        .extend([RECEIPT.into(), super::RECEIPT_FILE.into()]);
    owned.runtime_mutable_paths.clear();
    super::execution::validate_outputs(&owned, payload, &before, &permissions)?;
    checkpoint()
}

#[cfg(test)]
#[path = "preparation_source_tests.rs"]
mod tests;
