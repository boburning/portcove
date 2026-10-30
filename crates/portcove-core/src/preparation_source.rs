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

/// Native6 opts in through the existing original-file source contract.
pub(crate) fn native(port: &PortDefinition) -> bool {
    port.adapter == AdapterKind::NativePortable && port.source_profile.is_some()
}

pub(crate) fn validate_native(catalog: &Catalog, port: &PortDefinition) -> Result<()> {
    if !native(port) {
        return Ok(());
    }
    let profile_id = port
        .source_profile
        .as_deref()
        .expect("native source profile");
    let profile = catalog
        .source_catalog()
        .and_then(|sources| {
            sources
                .identities
                .iter()
                .find(|profile| profile.id == profile_id)
        })
        .ok_or_else(|| PortcoveError::usage("native originals require exact schema-2 file sets"))?;
    let variants = profile
        .variants
        .iter()
        .filter(|variant| !variant.legacy_projection_only)
        .collect::<Vec<_>>();
    let contracts = catalog
        .source_catalog()
        .into_iter()
        .flat_map(|sources| &sources.contracts)
        .filter(|contract| {
            contract.port_id == port.id
                && contract.profile_id == profile_id
                && contract.role == crate::PortSourceRole::Game
        })
        .collect::<Vec<_>>();
    let complete_contract = matches!(contracts.as_slice(), [contract]
        if contract.admission_mode == crate::CatalogAdmissionMode::Enforced
            && contract.validator_contract_id.is_none()
            && contract.supported_variant_ids.len() == variants.len()
            && variants.iter().all(|variant| contract.supported_variant_ids.contains(&variant.id)));
    if !complete_contract
        || !eligible(port)
        || catalog.source_profile(profile_id)?.kind != crate::SourceKind::FileSet
        || port.runtime_source_filename.is_some()
        || port.runtime_source_materialization.is_some()
        || !port.runtime_source_hashes.is_empty()
        || outputs(port).iter().any(|output| {
            let namespace = output.split('/').next().unwrap_or(output);
            port.persistent_paths
                .iter()
                .any(|path| crate::runtime::overlaps(namespace, path))
        })
        || port.setup_marker.is_some()
        || !port.setup_output_paths.is_empty()
        || port.portable_marker
        || port.launch_from_install_root
        || variants.is_empty()
        || variants.iter().any(|variant| {
            variant.representations.iter().any(|representation| {
                let crate::SourceRepresentationKind::FileSet { members } = &representation.kind
                else {
                    return true;
                };
                members.len() != port.runtime_source_set.len()
                    || members.iter().any(|member| {
                        member.identities.is_empty()
                            || member.identities.iter().any(|identity| {
                                identity.sha1.is_none() && identity.sha256.is_none()
                            })
                            || port
                                .runtime_source_set
                                .iter()
                                .filter(|target| {
                                    target.materialization == RuntimeSourceMaterialization::Copy
                                        && target.source_filenames.len() == member.filenames.len()
                                        && target.source_filenames.iter().all(|name| {
                                            member
                                                .filenames
                                                .iter()
                                                .any(|alias| alias.eq_ignore_ascii_case(name))
                                        })
                                })
                                .count()
                                != 1
                    })
            })
        })
    {
        return Err(PortcoveError::usage(
            "native originals require complete exact file-set copies with immutable, separate output ownership",
        ));
    }
    Ok(())
}

pub(crate) fn eligible(port: &PortDefinition) -> bool {
    if (port.adapter != AdapterKind::StagedSourcePortable && !native(port))
        || port.release.provider == crate::ReleaseSource::UserPrepared
        || port.managed_initialization.is_some()
        || port.managed_shared_preferences.is_some()
        || port.runtime_data_policy.is_some()
        || port.mod_package_policy.is_some()
        || port.n64_runtime_at_executable_parent
        || port.runtime_subdirectory.is_some()
        || (!native(port) && !port.persistent_file_patterns.is_empty())
        || !port.runtime_mutable_file_patterns.is_empty()
    {
        return false;
    }
    let outputs = outputs(port);
    let Ok(metadata) = crate::adapter::generated_metadata(port) else {
        return false;
    };
    !outputs.is_empty()
        && outputs.iter().enumerate().all(|(index, output)| {
            !crate::path::is_portcove_metadata(Path::new(output))
                && !port.persistent_file_patterns.iter().any(|pattern| {
                    output
                        .split('/')
                        .next()
                        .is_some_and(|name| pattern.matches(name))
                })
                && !metadata
                    .iter()
                    .any(|path| crate::runtime::overlaps(output, path))
                && !outputs[..index]
                    .iter()
                    .any(|prior| crate::runtime::overlaps(output, prior))
                && !port
                    .persistent_paths
                    .iter()
                    .chain(&port.runtime_mutable_paths)
                    .any(|path| crate::runtime::overlaps(output, path))
                && !port
                    .executable_hints
                    .values()
                    .chain(port.setup_executable_hints.values())
                    .flatten()
                    .any(|path| crate::runtime::overlaps(output, path))
                && !port
                    .bundled_runtime
                    .values()
                    .any(|runtime| crate::runtime::overlaps(output, &runtime.target_directory))
        })
}

/// Immutable original namespaces never acquire canonical player-data ownership.
pub(crate) fn require_canonical_originals(port: &PortDefinition, library: &Library) -> Result<()> {
    if !native(port) {
        return Ok(());
    }
    for path in outputs(port)
        .into_iter()
        .chain(crate::adapter::generated_metadata(port)?)
    {
        let namespace = path
            .split('/')
            .next()
            .ok_or_else(|| PortcoveError::state("native original namespace is missing"))?;
        crate::persistence::require_absent_path(&library.user_dir(&port.id), namespace).map_err(
            |error| {
                error.with_known_cause(
                    crate::failure::KnownFailureCause::PortableDataContractChanged,
                )
            },
        )?;
    }
    Ok(())
}

/// Fresh admission cannot interpret preserved profiles under a new creating contract.
/// Authenticated active imports already retain this exact data/source scope.
pub(crate) fn require_fresh_canonical_data(port: &PortDefinition, library: &Library) -> Result<()> {
    if !native(port) {
        return Ok(());
    }
    require_canonical_originals(port, library)?;
    if let Some(active) = library
        .status(&port.id, crate::ReleaseChannel::Stable)?
        .active
    {
        let catalog = Installer::new(library.clone())?
            .retained_catalog(&active)?
            .ok_or_else(|| {
                PortcoveError::conflict("native originals require their active creating contract")
            })?;
        let retained = catalog.port(&port.id)?;
        if !native(retained)
            || retained.source_profile != port.source_profile
            || retained.runtime_source_set != port.runtime_source_set
            || retained.persistent_paths != port.persistent_paths
            || retained.persistent_file_patterns != port.persistent_file_patterns
            || retained.windows_temp_directory != port.windows_temp_directory
            || retained.runtime_subdirectory != port.runtime_subdirectory
            || retained.launch_from_install_root != port.launch_from_install_root
            || retained.executable_hints != port.executable_hints
        {
            return Err(PortcoveError::conflict(
                "native original or player-data scope changed; preserve the existing installation and data",
            ));
        }
        return Ok(());
    }
    require_absent_player_data(port, &library.user_dir(&port.id))
}

fn require_absent_player_data(port: &PortDefinition, root: &Path) -> Result<()> {
    for relative in crate::persistence::entries(port, &[root])? {
        crate::persistence::require_absent_path(root, &relative).map_err(|error| {
            error.with_known_cause(crate::failure::KnownFailureCause::PortableDataContractChanged)
        })?;
    }
    Ok(())
}

pub(crate) fn require_pristine_adoption(
    port: &PortDefinition,
    payload: &Path,
    selected: &Path,
) -> Result<()> {
    if !native(port) {
        return Ok(());
    }
    require_pristine_package(port, payload, selected)?;
    let working = crate::adapter::launch_working_directory(port.adapter, port, payload, selected)?;
    require_absent_player_data(port, &working)
}

pub(crate) fn require_pristine_package(
    port: &PortDefinition,
    payload: &Path,
    selected: &Path,
) -> Result<()> {
    if !native(port) {
        return Ok(());
    }
    let qualification = crate::InstallQualification::from_port(port, Platform::current()?)?;
    if crate::install::resolve_declared_executable(payload, &qualification)? != selected {
        return Err(PortcoveError::verification(
            "native package executable selection changed",
        ));
    }
    let working = crate::adapter::launch_working_directory(port.adapter, port, payload, selected)?;
    require_vacant_outputs(
        port,
        payload,
        &working,
        &crate::library_transfer::reviewed_tree(payload)?,
    )
}

fn require_vacant_outputs(
    port: &PortDefinition,
    payload: &Path,
    working: &Path,
    before: &crate::AdoptionCopyPlan,
) -> Result<()> {
    let targets = outputs(port)
        .into_iter()
        .chain(crate::adapter::generated_metadata(port)?)
        .map(|path| working.join(path))
        .chain([payload.join(RECEIPT), payload.join(super::RECEIPT_FILE)]);
    for target in targets {
        let path = target
            .strip_prefix(payload)
            .map_err(|_| PortcoveError::verification("native originals escaped private payload"))?
            .to_string_lossy()
            .replace('\\', "/");
        if before.files.iter().any(|file| {
            crate::runtime::overlaps(
                &path,
                &file.relative_path.to_string_lossy().replace('\\', "/"),
            )
        }) || before.directories.iter().any(|directory| {
            let directory = directory.to_string_lossy().replace('\\', "/");
            let key = path.to_lowercase();
            let directory_key = directory.to_lowercase();
            Path::new(&directory_key).starts_with(&key)
                || (Path::new(&key).starts_with(&directory_key)
                    && !Path::new(&path).starts_with(&directory))
        }) {
            return Err(PortcoveError::verification(
                "publisher package occupies a native original output or receipt",
            ));
        }
    }
    Ok(())
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

pub(crate) fn definition(catalog: &Catalog, port: &PortDefinition) -> Result<String> {
    let profile = port
        .source_profile
        .as_deref()
        .ok_or_else(|| PortcoveError::state("runtime source preparation has no source profile"))?;
    if native(port) {
        let sources = catalog
            .source_catalog()
            .ok_or_else(|| PortcoveError::state("native originals have no exact source catalog"))?;
        let identity = sources
            .identities
            .iter()
            .find(|identity| identity.id == profile)
            .ok_or_else(|| PortcoveError::state("native original identity is missing"))?;
        let contracts = sources
            .contracts
            .iter()
            .filter(|contract| contract.port_id == port.id && contract.profile_id == profile)
            .collect::<Vec<_>>();
        return Ok(crate::signed_catalog::digest(&serde_json::to_vec(&(
            port, identity, contracts,
        ))?));
    }
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

pub(crate) fn require_publication(
    library: &Library,
    install: &InstallRecord,
    expected_plan: Option<&super::PreparationPlan>,
) -> Result<()> {
    let installer = Installer::new(library.clone())?;
    if installer.retained_preparation_mode(install)? != Some(PreparationMode::SourceOnly) {
        return Ok(());
    }
    let catalog = installer.retained_catalog(install)?.ok_or_else(|| {
        PortcoveError::verification("sealed source publication has no retained definition")
    })?;
    let port = catalog.port(&install.port_id)?;
    require_canonical_originals(port, library)?;
    let profile = port.source_profile.as_deref().ok_or_else(|| {
        PortcoveError::verification("sealed source publication has no source profile")
    })?;
    let source = library.source(profile)?.ok_or_else(|| {
        PortcoveError::source("sealed source publication requires its registered original")
    })?;
    crate::source_inspection::verify_registered(&catalog, &source)?;
    validate(
        library,
        &catalog,
        port,
        install,
        Some(&source),
        expected_plan,
    )
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

/// Coordinates belong to the exact private lifecycle payload. Replacement is
/// allowed only after verifying a copy of an authenticated prepared installation.
pub(crate) struct MaterializationRoot<'a> {
    pub payload: &'a Path,
    pub working: &'a Path,
    pub replace_prepared: bool,
}

/// The caller owns a private payload and joins this worker before publication or cleanup.
pub(crate) fn materialize(
    catalog: &Catalog,
    port: &PortDefinition,
    inputs: &SourcePreparation,
    root: MaterializationRoot<'_>,
    checkpoint: &dyn Fn() -> Result<()>,
    process_quiesced: &Cell<bool>,
) -> Result<()> {
    let MaterializationRoot {
        payload,
        working,
        replace_prepared,
    } = root;
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
    if native(port) {
        let qualification =
            crate::InstallQualification::from_catalog(catalog, &port.id, inputs.host)?;
        let selected = crate::install::resolve_declared_executable(payload, &qualification)?;
        let expected =
            crate::adapter::launch_working_directory(port.adapter, port, payload, &selected)?;
        if working != expected {
            return Err(PortcoveError::verification(
                "native originals differ from the selected executable coordinates",
            ));
        }
    } else if working != payload {
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

    let native_observation = if native(port) {
        let observation = crate::source_inspection::inspect_with_checkpoint(
            catalog,
            &inputs.source.profile_id,
            &inputs.source.path,
            checkpoint,
        )?;
        if !same_source(
            &observation.clone().require_admitted_record()?,
            &inputs.source,
        ) {
            return Err(PortcoveError::source(
                "native original set changed before copying",
            ));
        }
        Some(observation)
    } else {
        None
    };
    if native(port) && !replace_prepared {
        require_vacant_outputs(port, payload, working, &before)?;
    }
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
    materialize_single_source(port, inputs, working, checkpoint, process_quiesced)?;
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
    if let Some(observed) = native_observation {
        for target in &port.runtime_source_set {
            checkpoint()?;
            let component = observed
                .components
                .iter()
                .find(|component| {
                    component.name.as_ref().is_some_and(|name| {
                        target
                            .source_filenames
                            .iter()
                            .any(|alias| alias.eq_ignore_ascii_case(name))
                    })
                })
                .ok_or_else(|| {
                    PortcoveError::verification(
                        "native original target has no observed source member",
                    )
                })?;
            let (digest, size) = crate::adapter::hash_file_bounded_with_checkpoint(
                &working.join(&target.destination),
                component.size,
                checkpoint,
            )?;
            if size != component.size
                || !component.digests.iter().any(|expected| {
                    expected.algorithm == crate::SourceDigestAlgorithm::Sha256
                        && expected.value == digest
                })
            {
                return Err(PortcoveError::verification(
                    "native original copy differs from its admitted complete source set",
                ));
            }
        }
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
    owned.setup_output_paths = outputs(port)
        .into_iter()
        .chain(crate::adapter::generated_metadata(port)?)
        .map(|relative| {
            working
                .join(relative)
                .strip_prefix(payload)
                .map(|path| path.to_string_lossy().replace('\\', "/"))
                .map_err(|_| PortcoveError::verification("source output escaped private payload"))
        })
        .collect::<Result<Vec<_>>>()?;
    owned
        .setup_output_paths
        .extend([RECEIPT.into(), super::RECEIPT_FILE.into()]);
    owned.runtime_mutable_paths.clear();
    super::execution::validate_outputs(&owned, payload, &before, &permissions)?;
    checkpoint()
}

fn materialize_single_source(
    port: &PortDefinition,
    inputs: &SourcePreparation,
    working: &Path,
    checkpoint: &dyn Fn() -> Result<()>,
    process_quiesced: &Cell<bool>,
) -> Result<()> {
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
    Ok(())
}

#[cfg(test)]
#[path = "preparation_source_tests.rs"]
mod tests;
