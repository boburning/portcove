use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

use crate::{
    ChildProcessClass, ChildProcessPolicy, Library, OperationCoordinator, OperationEvent,
    OperationResult, Platform, PortcoveError, Result, SourceRecord,
    adapter::{hash_file, materialize_psx_chd},
    archive::{extract_archive, validate_download_progress, validate_download_size},
};

const TOOLCHAIN_VERSION: &str = "1.0.14";

#[derive(Debug, Clone)]
pub struct PsxManagedPreparation {
    pub source: SourceRecord,
    pub bios: Option<SourceRecord>,
    pub source_paths: Vec<PathBuf>,
    pub runtime_source_directory: Option<PathBuf>,
    pub toolchain_root: PathBuf,
    pub executable_basename: String,
}

#[derive(Debug, Clone, Copy)]
struct ToolchainArtifact {
    name: &'static str,
    size: u64,
    sha256: &'static str,
}

#[derive(Debug, Serialize, Deserialize)]
struct ToolchainMarker {
    schema_version: u32,
    version: String,
    platform: Platform,
    asset_name: String,
    sha256: String,
    critical_files: Vec<ToolchainFileIdentity>,
}

#[derive(Debug, Serialize, Deserialize)]
struct ToolchainFileIdentity {
    path: String,
    size: u64,
    sha256: String,
}

#[derive(Debug, Serialize)]
struct ManagedMarker<'a> {
    schema_version: u32,
    adapter: &'a str,
    source_sha256: &'a str,
    source_storage_sha256: &'a str,
    bios_source_sha256: Option<&'a str>,
    toolchain_version: &'a str,
}

struct DirectoryGuard(PathBuf);

impl Drop for DirectoryGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub(crate) async fn ensure_toolchain<F>(
    library: &Library,
    platform: Platform,
    parent: &OperationCoordinator,
    emit: &mut F,
) -> Result<PathBuf>
where
    F: FnMut(OperationEvent),
{
    let operation = parent.child("psx_toolchain", None);
    emit(operation.started());
    let result = ensure_toolchain_inner(library, platform, &operation, emit).await;
    emit(operation.finished(if result.is_ok() {
        OperationResult::Succeeded
    } else {
        OperationResult::Failed
    }));
    result
}

async fn ensure_toolchain_inner<F>(
    library: &Library,
    platform: Platform,
    operation: &OperationCoordinator,
    emit: &mut F,
) -> Result<PathBuf>
where
    F: FnMut(OperationEvent),
{
    let artifact = toolchain_artifact(platform)?;
    let destination = library
        .toolchains_dir()
        .join("cmake-clang-v1")
        .join(TOOLCHAIN_VERSION);
    if validate_toolchain(&destination, platform, artifact)? {
        return Ok(destination);
    }

    let operation_root = library
        .staging_dir()
        .join(format!("psx-toolchain-{}", Uuid::new_v4()));
    let guard = DirectoryGuard(operation_root.clone());
    let unpacked = operation_root.join("unpacked");
    fs::create_dir_all(&unpacked)?;
    let archive_path = operation_root.join(artifact.name);
    let url = format!(
        "https://github.com/TechnicallyComputers/retcomm-toolchains/releases/download/v{TOOLCHAIN_VERSION}/{}",
        artifact.name
    );
    let client = reqwest::Client::builder()
        .user_agent(concat!("Portcove/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| PortcoveError::network(error.to_string()))?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| PortcoveError::network(error.to_string()))?
        .error_for_status()
        .map_err(|error| PortcoveError::network(error.to_string()))?;
    validate_download_progress(0, artifact.size)?;
    let mut stream = response.bytes_stream();
    let mut file = tokio::fs::File::create(&archive_path).await?;
    let mut completed = 0_u64;
    let mut reported = 0_u64;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| PortcoveError::network(error.to_string()))?;
        file.write_all(&chunk).await?;
        completed += chunk.len() as u64;
        validate_download_progress(completed, artifact.size)?;
        if completed == artifact.size || completed.saturating_sub(reported) >= 1024 * 1024 {
            emit(operation.progress("psx-toolchain-download", completed, Some(artifact.size)));
            reported = completed;
        }
    }
    if completed != reported {
        emit(operation.progress("psx-toolchain-download", completed, Some(artifact.size)));
    }
    file.flush().await?;
    drop(file);
    validate_download_size(completed, artifact.size)?;
    let (actual_sha256, actual_size) = hash_file(&archive_path)?;
    if actual_size != artifact.size || !actual_sha256.eq_ignore_ascii_case(artifact.sha256) {
        return Err(PortcoveError::verification(
            "PS1 toolchain failed its pinned artifact verification",
        )
        .detail("expected_sha256", artifact.sha256)
        .detail("actual_sha256", actual_sha256)
        .detail("expected_size", artifact.size.to_string())
        .detail("actual_size", actual_size.to_string()));
    }

    extract_archive(&archive_path, &unpacked, artifact.name, artifact.size)?;
    let pack_root = locate_pack_root(&unpacked)?;
    let critical_files = toolchain_file_identities(&pack_root, platform)?;
    let marker = ToolchainMarker {
        schema_version: 2,
        version: TOOLCHAIN_VERSION.into(),
        platform,
        asset_name: artifact.name.into(),
        sha256: artifact.sha256.into(),
        critical_files,
    };
    fs::write(
        pack_root.join(".portcove-toolchain.json"),
        serde_json::to_vec_pretty(&marker)?,
    )?;
    fs::create_dir_all(destination.parent().expect("toolchain has a parent"))?;
    if destination.exists() {
        fs::remove_dir_all(&destination)?;
    }
    fs::rename(&pack_root, &destination)?;
    if !validate_toolchain(&destination, platform, artifact)? {
        return Err(PortcoveError::verification(
            "installed PS1 toolchain did not pass its post-install checks",
        ));
    }
    drop(guard);
    Ok(destination)
}

pub(crate) fn prepare_install(root: &Path, preparation: &PsxManagedPreparation) -> Result<()> {
    crate::adapter::verify_source_storage_identity(&preparation.source, "PS1 source")?;
    if let Some(bios) = &preparation.bios {
        crate::adapter::verify_source_storage_identity(bios, "PS1 BIOS")?;
    }
    let cli = root.join("psxrecomp").join("psxrecomp_cli.py");
    let config = root.join("game.toml");
    if !cli.is_file() || !config.is_file() {
        return Err(PortcoveError::install(
            "PS1 setup package is missing its fixed psxrecomp CLI contract",
        ));
    }
    let python = toolchain_python(&preparation.toolchain_root)?;
    let temporary = tempfile::Builder::new()
        .prefix("psx-source-")
        .tempdir_in(root.parent().unwrap_or(root))?;
    let primary_source = preparation.source_paths.first().ok_or_else(|| {
        PortcoveError::source("managed PS1 preparation has no verified disc source")
    })?;
    let cue = materialize_psx_chd(primary_source, temporary.path())?;
    crate::adapter::verify_source_storage_identity(&preparation.source, "PS1 source")?;
    let config_path = crate::path::unicode(&config, "managed build config")?;
    let project_root = crate::path::unicode(root, "managed build root")?;
    let mut generate_arguments = vec![
        "generate".into(),
        "--config".into(),
        config_path.clone(),
        "--project-root".into(),
        project_root.clone(),
        "--disc".into(),
        crate::path::unicode(&cue, "managed disc")?,
    ];
    if let Some(bios) = &preparation.bios {
        generate_arguments.extend([
            "--bios".into(),
            crate::path::unicode(&bios.path, "BIOS source")?,
        ]);
    }
    generate_arguments.push("--json-progress".into());
    run_cli(
        &python,
        &cli,
        root,
        &preparation.toolchain_root,
        generate_arguments,
    )?;
    if let Some(bios) = &preparation.bios {
        crate::adapter::verify_source_storage_identity(bios, "PS1 BIOS")?;
    }
    rewrite_game_discs(&config, &preparation.source_paths)?;
    let build_dir = root.join("build-portcove");
    run_cli(
        &python,
        &cli,
        root,
        &preparation.toolchain_root,
        [
            "rebuild".into(),
            "--config".into(),
            config_path,
            "--project-root".into(),
            project_root,
            "--build-dir".into(),
            crate::path::unicode(&build_dir, "managed build directory")?,
            "--target".into(),
            "psx-runtime".into(),
            "--exe-basename".into(),
            preparation.executable_basename.clone(),
            "--no-pgo".into(),
            "--no-toolchain-download".into(),
            "--prune-after".into(),
            "build-intermediates".into(),
            "--json-progress".into(),
        ],
    )?;
    let executable = platform_executable(&build_dir, &preparation.executable_basename);
    if !executable.is_file() {
        return Err(PortcoveError::install(format!(
            "PS1 build completed without {}",
            executable.display()
        )));
    }
    let runtime_sources = if let Some(relative) = &preparation.runtime_source_directory {
        materialize_runtime_raw_set(&build_dir, relative, preparation)?
    } else {
        preparation.source_paths.clone()
    };
    let runtime_config = build_dir.join("game.toml");
    prepare_runtime_config(&config, &runtime_config, &runtime_sources)?;
    crate::adapter::verify_source_storage_identity(&preparation.source, "PS1 source")?;
    let prepared_disc = root.join("disc");
    if prepared_disc.is_dir() {
        fs::remove_dir_all(prepared_disc)?;
    }
    let staged_bios = root.join("psxrecomp").join("bios").join("SCPH1001.BIN");
    if staged_bios.is_file() {
        fs::remove_file(staged_bios)?;
    }
    fs::write(
        root.join(".portcove-managed.json"),
        serde_json::to_vec_pretty(&ManagedMarker {
            schema_version: 1,
            adapter: "psx-recomp-managed",
            source_sha256: &preparation.source.sha256,
            source_storage_sha256: &preparation.source.storage_sha256,
            bios_source_sha256: preparation.bios.as_ref().map(|bios| bios.sha256.as_str()),
            toolchain_version: TOOLCHAIN_VERSION,
        })?,
    )?;
    Ok(())
}

pub(crate) fn rewrite_game_discs(config: &Path, sources: &[PathBuf]) -> Result<()> {
    let body = fs::read_to_string(config)?;
    let mut output = Vec::new();
    let mut in_game = false;
    let mut skipping_discs = false;
    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            in_game = trimmed == "[game]";
            skipping_discs = false;
        }
        if in_game && (trimmed.starts_with("disc =") || trimmed.starts_with("discs =")) {
            skipping_discs = trimmed.starts_with("discs =") && !trimmed.contains(']');
            continue;
        }
        if skipping_discs {
            if trimmed.contains(']') {
                skipping_discs = false;
            }
            continue;
        }
        output.push(line.to_string());
        if trimmed == "[game]" {
            if sources.len() == 1 {
                output.push(format!(
                    "disc = {}",
                    serde_json::to_string(&crate::path::unicode(&sources[0], "PS1 source")?)?
                ));
            } else {
                output.push("discs = [".into());
                for source in sources {
                    output.push(format!(
                        "    {},",
                        serde_json::to_string(&crate::path::unicode(source, "PS1 source")?)?
                    ));
                }
                output.push("]".into());
            }
        }
    }
    fs::write(config, format!("{}\n", output.join("\n")))?;
    Ok(())
}

fn prepare_runtime_config(project: &Path, runtime: &Path, sources: &[PathBuf]) -> Result<()> {
    if !runtime.is_file() {
        fs::copy(project, runtime)?;
    }
    rewrite_game_discs(runtime, sources)
}

fn materialize_runtime_raw_set(
    build_dir: &Path,
    relative: &Path,
    preparation: &PsxManagedPreparation,
) -> Result<Vec<PathBuf>> {
    let relative_text = crate::path::unicode(relative, "managed PS1 runtime source")?;
    let normalized_relative = relative_text.replace('\\', "/");
    crate::archive::validate_relative_path(&normalized_relative, false)?;
    let destination = build_dir.join(relative);
    crate::adapter::materialize_psx_cue_set(&preparation.source.path, &destination)?;

    let mut runtime_sources = Vec::with_capacity(preparation.source_paths.len());
    let mut hashes = Vec::with_capacity(preparation.source_paths.len());
    let mut total_size = 0_u64;
    for index in 0..preparation.source_paths.len() {
        let bin_filename = format!("disc-{:02}.bin", index + 1);
        let materialized = destination.join(&bin_filename);
        if !materialized.is_file() {
            return Err(PortcoveError::verification(format!(
                "managed PS1 runtime source is missing {bin_filename}"
            )));
        }
        let (sha256, size) = hash_file(&materialized)?;
        hashes.push(sha256);
        total_size = total_size.saturating_add(size);
        let cue_filename = format!("disc-{:02}.cue", index + 1);
        if !destination.join(&cue_filename).is_file() {
            return Err(PortcoveError::verification(format!(
                "managed PS1 runtime source is missing {cue_filename}"
            )));
        }
        runtime_sources.push(PathBuf::from(format!(
            "{normalized_relative}/{cue_filename}"
        )));
    }
    let aggregate = crate::adapter::aggregate_sha256(&hashes);
    if aggregate != preparation.source.sha256 || total_size != preparation.source.size {
        return Err(PortcoveError::verification(
            "managed PS1 runtime source does not match the verified disc set",
        )
        .detail("expected_sha256", &preparation.source.sha256)
        .detail("actual_sha256", aggregate)
        .detail("expected_size", preparation.source.size.to_string())
        .detail("actual_size", total_size.to_string()));
    }
    Ok(runtime_sources)
}

fn run_cli(
    python: &Path,
    cli: &Path,
    project_root: &Path,
    toolchain_root: &Path,
    arguments: impl IntoIterator<Item = String>,
) -> Result<()> {
    let output = ChildProcessPolicy::native_command(ChildProcessClass::ManagedBuilder, python)?
        .arg(cli)
        .args(arguments)
        .current_dir(project_root)
        .env("RETCOMM_TOOLCHAIN_DIR", toolchain_root)
        .env("PSXRECOMP_TOOLCHAIN_DIR", toolchain_root)
        .output()
        .map_err(|error| PortcoveError::install(format!("could not start PS1 builder: {error}")))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let detail = stderr
        .lines()
        .chain(stdout.lines())
        .rev()
        .take(20)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n");
    Err(
        PortcoveError::install(format!("PS1 builder exited with {}", output.status))
            .detail("output_tail", detail),
    )
}

fn toolchain_artifact(platform: Platform) -> Result<ToolchainArtifact> {
    match platform {
        Platform::WindowsX86_64 => Ok(ToolchainArtifact {
            name: "cmake-clang-v1-windows-x64.zip",
            size: 209_497_009,
            sha256: "28da9742385e7ff875b3d9311e8ed89dbdc84f27b6ecba2bc0d0acc11f6d2b4d",
        }),
        Platform::LinuxX86_64 => Ok(ToolchainArtifact {
            name: "cmake-clang-v1-linux-x64.zip",
            size: 833_435_449,
            sha256: "597c8d343a3cf02ba6f6b2ae7cf6fe2fef125dde8feff62a144e8dd3da3d484e",
        }),
        Platform::MacosX86_64 | Platform::MacosAarch64 => Ok(ToolchainArtifact {
            name: "cmake-clang-v1-macos-universal.zip",
            size: 95_921_806,
            sha256: "9db2a9b6ede4162cb19850ee1a08d01147f3ea8bc9b2eefb3ffbdf8b20d389d7",
        }),
    }
}

fn validate_toolchain(
    root: &Path,
    platform: Platform,
    artifact: ToolchainArtifact,
) -> Result<bool> {
    let marker_path = root.join(".portcove-toolchain.json");
    if !marker_path.is_file() {
        return Ok(false);
    }
    let marker: ToolchainMarker = serde_json::from_slice(&fs::read(marker_path)?)?;
    if marker.schema_version != 2
        || marker.version != TOOLCHAIN_VERSION
        || marker.platform != platform
        || marker.asset_name != artifact.name
        || !marker.sha256.eq_ignore_ascii_case(artifact.sha256)
    {
        return Ok(false);
    }
    let Ok(expected) = toolchain_file_identities(root, platform) else {
        return Ok(false);
    };
    if marker.critical_files.len() != expected.len() {
        return Ok(false);
    }
    let recorded = marker
        .critical_files
        .into_iter()
        .map(|file| (file.path, file.size, file.sha256))
        .collect::<BTreeSet<_>>();
    let actual = expected
        .into_iter()
        .map(|file| (file.path, file.size, file.sha256))
        .collect::<BTreeSet<_>>();
    Ok(recorded == actual)
}

fn toolchain_file_identities(
    root: &Path,
    _platform: Platform,
) -> Result<Vec<ToolchainFileIdentity>> {
    let paths = [
        toolchain_python(root)?,
        platform_executable(&root.join("bin"), "cmake"),
        platform_executable(&root.join("bin"), "ninja"),
        root.join("retcomm-toolchain.json"),
    ];
    let mut identities = Vec::with_capacity(paths.len());
    for path in paths {
        if !path.is_file() {
            return Err(PortcoveError::verification(format!(
                "PS1 toolchain is missing a critical file: {}",
                path.display()
            )));
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|_| PortcoveError::verification("toolchain file escaped its root"))?
            .to_str()
            .ok_or_else(|| PortcoveError::verification("toolchain path is not Unicode"))?
            .replace('\\', "/");
        let (sha256, size) = hash_file(&path)?;
        identities.push(ToolchainFileIdentity {
            path: relative,
            size,
            sha256,
        });
    }
    identities.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(identities)
}

fn toolchain_python(root: &Path) -> Result<PathBuf> {
    let candidates = if cfg!(windows) {
        vec![root.join("python").join("python.exe")]
    } else {
        vec![
            root.join("python").join("bin").join("python3"),
            root.join("python").join("bin").join("python"),
        ]
    };
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| {
            PortcoveError::verification("PS1 toolchain is missing its bundled Python runtime")
        })
}

fn platform_executable(root: &Path, basename: &str) -> PathBuf {
    if cfg!(windows) {
        root.join(format!("{basename}.exe"))
    } else {
        root.join(basename)
    }
}

fn locate_pack_root(unpacked: &Path) -> Result<PathBuf> {
    if unpacked.join("retcomm-toolchain.json").is_file() {
        return Ok(unpacked.to_path_buf());
    }
    let mut directories = fs::read_dir(unpacked)?
        .filter_map(std::result::Result::ok)
        .filter(|entry| entry.path().is_dir())
        .map(|entry| entry.path());
    let candidate = directories.next().ok_or_else(|| {
        PortcoveError::verification("toolchain ZIP did not contain a package root")
    })?;
    if directories.next().is_some() || !candidate.join("retcomm-toolchain.json").is_file() {
        return Err(PortcoveError::verification(
            "toolchain ZIP has an unsupported package layout",
        ));
    }
    Ok(candidate)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toolchain_marker_is_bound_to_current_critical_file_bytes() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path();
        let platform = Platform::current().unwrap();
        let artifact = toolchain_artifact(platform).unwrap();
        let python = if cfg!(windows) {
            root.join("python").join("python.exe")
        } else {
            root.join("python").join("bin").join("python3")
        };
        let cmake = platform_executable(&root.join("bin"), "cmake");
        let ninja = platform_executable(&root.join("bin"), "ninja");
        for (path, bytes) in [
            (&python, b"python".as_slice()),
            (&cmake, b"cmake".as_slice()),
            (&ninja, b"ninja".as_slice()),
            (&root.join("retcomm-toolchain.json"), b"metadata".as_slice()),
        ] {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, bytes).unwrap();
        }
        let marker = ToolchainMarker {
            schema_version: 2,
            version: TOOLCHAIN_VERSION.into(),
            platform,
            asset_name: artifact.name.into(),
            sha256: artifact.sha256.into(),
            critical_files: toolchain_file_identities(root, platform).unwrap(),
        };
        fs::write(
            root.join(".portcove-toolchain.json"),
            serde_json::to_vec_pretty(&marker).unwrap(),
        )
        .unwrap();
        assert!(validate_toolchain(root, platform, artifact).unwrap());

        fs::write(&cmake, b"tampered cmake").unwrap();

        assert!(!validate_toolchain(root, platform, artifact).unwrap());
    }

    #[test]
    fn pinned_toolchains_cover_every_platform() {
        for platform in [
            Platform::WindowsX86_64,
            Platform::LinuxX86_64,
            Platform::MacosX86_64,
            Platform::MacosAarch64,
        ] {
            let artifact = toolchain_artifact(platform).unwrap();
            assert_eq!(artifact.sha256.len(), 64);
            assert!(artifact.size > 1_000_000);
        }
    }

    #[test]
    fn runtime_config_replaces_upstream_disc_paths_with_verified_chds() {
        let temporary = tempfile::tempdir().unwrap();
        let config = temporary.path().join("game.toml");
        fs::write(
            &config,
            "[game]\nname = \"Example\"\ndiscs = [\n  \"/maintainer/disc1.cue\",\n  \"/maintainer/disc2.cue\",\n]\ndisc_serials = [\"ONE\", \"TWO\"]\n\n[runtime]\nwindow_title = \"Example\"\n",
        )
        .unwrap();
        let sources = [
            PathBuf::from(r"D:\ROMs\Example (Disc 1).chd"),
            PathBuf::from(r"D:\ROMs\Example (Disc 2).chd"),
        ];

        rewrite_game_discs(&config, &sources).unwrap();

        let body = fs::read_to_string(config).unwrap();
        assert!(body.contains(r#"    "D:\\ROMs\\Example (Disc 1).chd","#));
        assert!(body.contains(r#"    "D:\\ROMs\\Example (Disc 2).chd","#));
        assert!(!body.contains("/maintainer"));
        assert!(body.contains("disc_serials"));
        assert!(body.contains("[runtime]"));
    }

    #[test]
    fn runtime_config_is_seeded_when_an_upstream_build_omits_it() {
        let temporary = tempfile::tempdir().unwrap();
        let project = temporary.path().join("game.toml");
        let runtime = temporary.path().join("build").join("game.toml");
        fs::write(&project, "[game]\ndisc = \"maintainer.cue\"\n").unwrap();
        fs::create_dir_all(runtime.parent().unwrap()).unwrap();
        let sources = [PathBuf::from(r"D:\ROMs\Game.chd")];

        prepare_runtime_config(&project, &runtime, &sources).unwrap();

        let body = fs::read_to_string(runtime).unwrap();
        assert!(body.contains(r#"disc = "D:\\ROMs\\Game.chd""#));
        assert!(!body.contains("maintainer.cue"));
    }

    #[test]
    fn runtime_config_accepts_relative_immutable_cue_descriptors() {
        let temporary = tempfile::tempdir().unwrap();
        let config = temporary.path().join("game.toml");
        fs::write(
            &config,
            "[game]\ndiscs = [\n  \"maintainer-1.cue\",\n  \"maintainer-2.cue\",\n]\n",
        )
        .unwrap();
        let sources = [
            PathBuf::from("runtime-discs/disc-01.cue"),
            PathBuf::from("runtime-discs/disc-02.cue"),
        ];

        rewrite_game_discs(&config, &sources).unwrap();

        let body = fs::read_to_string(config).unwrap();
        assert!(body.contains(r#"    "runtime-discs/disc-01.cue","#));
        assert!(body.contains(r#"    "runtime-discs/disc-02.cue","#));
        assert!(!body.contains("maintainer"));
    }
}
