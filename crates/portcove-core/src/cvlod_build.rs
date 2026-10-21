//! One fixed original-driven Legacy of Darkness Windows recipe.
//! Definitions select this recipe; they cannot supply a compiler, SDK or script.
use super::{BuildArchive, CartridgeBuildPreparation, TOOLCHAIN, digest};
use crate::{CartridgeBuildRecipe, Platform, PortcoveError, Result, SourceRecord};
use std::{collections::BTreeMap, path::Path};

#[path = "cvlod_build/archives.rs"]
mod archive_facts;
#[path = "cvlod_build/compiler_options.rs"]
mod compiler_options;
#[path = "cvlod_build/local_profile.rs"]
mod local_profile;
#[path = "cvlod_build/pipeline.rs"]
mod pipeline;
#[path = "cvlod_build/plan.rs"]
mod plan;
#[path = "cvlod_build/sources.rs"]
mod sources;

#[cfg(windows)]
#[path = "cvlod_build/cleanup.rs"]
pub(crate) mod cleanup;

#[cfg(test)]
#[path = "cvlod_build/tests.rs"]
mod tests;

const RECIPE: CartridgeBuildRecipe = CartridgeBuildRecipe::CvlodSourceV1;
const VERSION: &str = "source-cb8548d145a1-ui-lifetime-v1";
const ORIGINAL: &str = "89e15df6042defddc48c61f7408f99d06fffdb845e2422cf8b5ba8e73d4d70fb";
const ORIGINAL_SIZE: u64 = 16_777_216;
const CMAKE: BuildArchive = BuildArchive {
    name: "cvlod-cmake-3.31.12.zip",
    url: "https://github.com/Kitware/CMake/releases/download/v3.31.12/cmake-3.31.12-windows-x86_64.zip",
    size: 46_666_397,
    sha256: "0c4baa40f28b3f8225eb3fdf6946c987b4fe901403b4eaf2fbbd9378100aaa0c",
    root: "cmake-3.31.12-windows-x86_64",
};

pub(super) fn archives() -> Vec<BuildArchive> {
    let mut archives = archive_facts::SOURCES.to_vec();
    archives.extend([CMAKE, pipeline::SDL, TOOLCHAIN, pipeline::DXC]);
    archives
}

pub(crate) fn blobs() -> Result<Vec<sources::Blob>> {
    sources::blobs()
}

pub(crate) fn require_build_prerequisites() -> Result<()> {
    if Platform::current()? != Platform::WindowsX86_64 {
        return Err(PortcoveError::unsupported(
            "the CVLoD source recipe requires Windows x64",
        ));
    }
    local_profile::require_present(&|| Ok(()))
}

pub(super) fn source_roots(work: &Path) -> Result<Vec<std::path::PathBuf>> {
    let mut roots: Vec<_> = archives()
        .iter()
        .map(|a| work.join(a.name.trim_end_matches(".zip")).join(a.root))
        .collect();
    roots.extend(sources::raw_roots(work)?);
    roots.extend([work.join("local-toolchain"), work.join("clang-cl")]);
    let generated = work.join("generated-recompiler");
    if generated.exists() {
        roots.push(generated);
    }
    for name in ["sdk-source", "prefix"] {
        let root = work.join(name);
        if root.exists() {
            roots.push(root);
        }
    }
    Ok(roots)
}

pub(super) fn primary_asset() -> crate::ReleaseAsset {
    let game = archive_facts::SOURCES[0];
    crate::ReleaseAsset { name: "cb8548d145a1077b8f03b9f5c0590b4cc8b3a03d.zip".into(),
        url: "https://github.com/fliperama86/cvlod_recomp/archive/cb8548d145a1077b8f03b9f5c0590b4cc8b3a03d.zip".into(),
        size: game.size, sha256: game.sha256.into() }
}

pub(crate) fn resolve(channel: crate::ReleaseChannel) -> Result<crate::ResolvedRelease> {
    if channel != crate::ReleaseChannel::Stable {
        return Err(PortcoveError::unsupported(
            "CVLoD source recipe offers its fixed stable route only",
        ));
    }
    Ok(crate::ResolvedRelease {
        version: VERSION.into(),
        channel,
        published_at: None,
        asset: primary_asset(),
    })
}

pub(super) fn verify_release(release: &crate::ResolvedRelease) -> Result<()> {
    if serde_json::to_value(release)?
        != serde_json::to_value(resolve(crate::ReleaseChannel::Stable)?)?
    {
        return Err(PortcoveError::verification(
            "CVLoD requires its exact reviewed source archive",
        ));
    }
    Ok(())
}

pub(super) fn validate_port(
    port: &crate::PortDefinition,
    profile: &crate::SourceProfile,
) -> Result<()> {
    if port.id != "cvlod-recomp"
        || port.project_url != "https://github.com/fliperama86/cvlod_recomp"
        || port.release.repository != "fliperama86/cvlod_recomp"
        || port.release.provider != crate::ReleaseSource::Github
        || port.release.managed_build != BTreeMap::from([(Platform::WindowsX86_64, RECIPE)])
        || !port.release.direct.is_empty()
        || !port.release.user_prepared.is_empty()
        || !port.release.curated.is_empty()
        || port.release.rolling_tag.is_some()
        || port.channels != [crate::ReleaseChannel::Stable]
        || port.adapter != crate::AdapterKind::N64RecompPortable
        || port.platforms
            != [
                Platform::WindowsX86_64,
                Platform::LinuxX86_64,
                Platform::MacosAarch64,
            ]
        || port.source_profile.as_deref() != Some("castlevania-legacy-of-darkness")
        || port.bios_source_profile.is_some()
        || port.runtime_data_policy.is_some()
        || port.managed_shared_preferences.is_some()
        || profile.id != "castlevania-legacy-of-darkness"
        || profile.kind != crate::SourceKind::File
        || profile.accepted_sha1 != ["879ead98f197fd05edda867655da5b1ce25aa5b8"]
        || !profile.accepted_sha256.is_empty()
        || !port.portable_marker
        || port.n64_windows_initial_d3d12
        || port.managed_initialization.is_some()
        || port.runtime_source_filename.as_deref() != Some("rom.z64")
        || port.runtime_source_materialization
            != Some(crate::RuntimeSourceMaterialization::N64BigEndian)
        || !port.runtime_source_set.is_empty()
        || port.runtime_source_hashes != BTreeMap::from([("rom.z64".into(), ORIGINAL.into())])
        || port.windows_runtime_path_policy
            != Some(crate::WindowsRuntimePathPolicy::PrintableAsciiMaxPath)
        || port.source_environment.is_some()
        || port.user_data_environment.is_some()
        || !port.launch_environment.is_empty()
        || !port.launch_arguments.is_empty()
        || port.launch_from_install_root
        || port.runtime_subdirectory.is_some()
        || !port.bundled_runtime.is_empty()
        || !port.setup_executable_hints.is_empty()
        || !port.setup_arguments.is_empty()
        || port.setup_marker.is_some()
        || !port.setup_output_paths.is_empty()
        || port.persistent_paths
            != [
                "rom.z64",
                "saves",
                "mods",
                "mods.json",
                "mod_config",
                "graphics.json",
                "audio.json",
                "controls.json",
                "rom_path.txt",
                "cheats.cfg",
            ]
        || port.runtime_mutable_paths != ["castlevania2.n64.us.z64", "LodRecomp.log"]
        || !port.persistent_file_patterns.is_empty()
        || !port.runtime_mutable_file_patterns.is_empty()
        || port.executable_hints.get(&Platform::WindowsX86_64)
            != Some(&vec!["LodRecomp.exe".into()])
    {
        return Err(PortcoveError::verification(
            "CVLoD fixed source, runtime or ownership contract differs",
        ));
    }
    Ok(())
}

pub(super) fn verify_original(
    source: &SourceRecord,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<()> {
    checkpoint()?;
    if source.profile_id != "castlevania-legacy-of-darkness"
        || source.sha256 != ORIGINAL
        || source.size != ORIGINAL_SIZE
        || source.storage_size != ORIGINAL_SIZE
        || !source
            .path
            .extension()
            .and_then(|s| s.to_str())
            .is_some_and(|s| {
                ["z64", "n64", "v64"]
                    .iter()
                    .any(|e| s.eq_ignore_ascii_case(e))
            })
    {
        return Err(PortcoveError::source(
            "CVLoD builds require the exact raw North American .z64, .n64 or .v64 original",
        ));
    }
    crate::path::refuse_symlink_ancestors(&source.path)?;
    let (sha, size) =
        crate::adapter::hash_file_bounded_with_checkpoint(&source.path, ORIGINAL_SIZE, checkpoint)?;
    if sha != source.storage_sha256 || size != ORIGINAL_SIZE {
        return Err(PortcoveError::source(
            "CVLoD stored original changed after verification",
        ));
    }
    checkpoint()
}

pub(super) fn storage_identity(primary_sha256: &str, source: &SourceRecord) -> Result<String> {
    Ok(digest(&serde_json::to_vec(&(
        "Portcove CVLoD fixed source build v1",
        RECIPE,
        primary_sha256,
        ORIGINAL,
        source.storage_sha256.as_str(),
        source.storage_size,
        archives(),
        sources::identity(),
        local_profile::ID,
        local_profile::identity(),
        pipeline::identity(),
        (pipeline::PATCH_BEFORE, pipeline::PATCH_AFTER),
        (compiler_options::BEFORE, compiler_options::AFTER),
        RECIPE.original_filename(),
        "RelWithDebInfo/MD/clang-cl22/MSVC14.44/SDK19041/DirectX614/SDL2.30.3/fonts+SVG/upstream-defaults",
        ["rom.z64", "--save-dir", "saves"],
    ))?))
}

pub(super) fn validate_command_result(
    phase: &str,
    status: &std::process::ExitStatus,
    diagnostic: &crate::ActivityDiagnostic,
) -> Result<()> {
    pipeline::validate_command_result(phase, status, diagnostic)
}

pub(super) fn require_runtime_environment() -> Result<()> {
    // Executable substitution and unoffered debug environment are not part of
    // this exact route. Do not require build prerequisites for verified launch.
    for (name, value) in std::env::vars_os() {
        let name = name.to_string_lossy().to_ascii_uppercase();
        if !value.is_empty()
            && (name == "SDL_DYNAMIC_API"
                || name.starts_with("LOD_")
                || name.starts_with("RECOMP_UI_"))
        {
            return Err(PortcoveError::unsupported(
                "CVLoD fixed runtime refuses ambient executable or debug overrides",
            )
            .detail("variable", name));
        }
    }
    Ok(())
}

pub(super) fn prepare_install(
    work: &Path,
    payload: &Path,
    preparation: &CartridgeBuildPreparation,
    library: &crate::Library,
    operation: &crate::OperationCoordinator,
    quiesced: &mut bool,
) -> Result<()> {
    pipeline::prepare_install(work, payload, preparation, library, operation, quiesced)
}
