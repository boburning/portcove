use std::{
    fs::{self, File},
    io::Read,
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
};

const TOOLCHAIN_VERSION: &str = "1.0.14";

#[derive(Debug, Clone)]
pub struct PsxManagedPreparation {
    pub source: SourceRecord,
    pub bios: Option<SourceRecord>,
    pub source_paths: Vec<PathBuf>,
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
    let mut stream = response.bytes_stream();
    let mut file = tokio::fs::File::create(&archive_path).await?;
    let mut completed = 0_u64;
    let mut reported = 0_u64;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| PortcoveError::network(error.to_string()))?;
        file.write_all(&chunk).await?;
        completed += chunk.len() as u64;
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

    extract_toolchain(&archive_path, &unpacked)?;
    let pack_root = locate_pack_root(&unpacked)?;
    let marker = ToolchainMarker {
        schema_version: 1,
        version: TOOLCHAIN_VERSION.into(),
        platform,
        asset_name: artifact.name.into(),
        sha256: artifact.sha256.into(),
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
    let mut generate_arguments = vec![
        "generate".into(),
        "--config".into(),
        config.to_string_lossy().into_owned(),
        "--project-root".into(),
        root.to_string_lossy().into_owned(),
        "--disc".into(),
        cue.to_string_lossy().into_owned(),
    ];
    if let Some(bios) = &preparation.bios {
        generate_arguments.extend(["--bios".into(), bios.path.to_string_lossy().into_owned()]);
    }
    generate_arguments.push("--json-progress".into());
    run_cli(
        &python,
        &cli,
        root,
        &preparation.toolchain_root,
        generate_arguments,
    )?;
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
            config.to_string_lossy().into_owned(),
            "--project-root".into(),
            root.to_string_lossy().into_owned(),
            "--build-dir".into(),
            build_dir.to_string_lossy().into_owned(),
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
    let runtime_config = build_dir.join("game.toml");
    prepare_runtime_config(&config, &runtime_config, &preparation.source_paths)?;
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
                    serde_json::to_string(&sources[0].to_string_lossy())?
                ));
            } else {
                output.push("discs = [".into());
                for source in sources {
                    output.push(format!(
                        "    {},",
                        serde_json::to_string(&source.to_string_lossy())?
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
    if marker.version != TOOLCHAIN_VERSION
        || marker.platform != platform
        || marker.asset_name != artifact.name
        || !marker.sha256.eq_ignore_ascii_case(artifact.sha256)
    {
        return Ok(false);
    }
    Ok(toolchain_python(root).is_ok()
        && platform_executable(&root.join("bin"), "cmake").is_file()
        && platform_executable(&root.join("bin"), "ninja").is_file())
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

fn extract_toolchain(source: &Path, destination: &Path) -> Result<()> {
    let mut archive = zip::ZipArchive::new(File::open(source)?)
        .map_err(|error| PortcoveError::verification(format!("invalid toolchain ZIP: {error}")))?;
    if archive.len() > 100_000 {
        return Err(PortcoveError::verification(
            "toolchain ZIP contains too many entries",
        ));
    }
    let total_size = (0..archive.len()).try_fold(0_u64, |total, index| {
        let entry = archive.by_index(index).map_err(|error| {
            PortcoveError::verification(format!("invalid toolchain ZIP entry: {error}"))
        })?;
        total
            .checked_add(entry.size())
            .ok_or_else(|| PortcoveError::verification("toolchain ZIP expanded size overflowed"))
    })?;
    if total_size > 4 * 1024 * 1024 * 1024 {
        return Err(PortcoveError::verification(
            "toolchain ZIP exceeds its expanded size limit",
        ));
    }
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| {
            PortcoveError::verification(format!("invalid toolchain ZIP entry: {error}"))
        })?;
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(PortcoveError::verification(
                "toolchain ZIP links are not allowed",
            ));
        }
        let relative = entry
            .enclosed_name()
            .ok_or_else(|| PortcoveError::verification("toolchain ZIP contains an unsafe path"))?;
        let output = destination.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(&output)?;
            continue;
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut file = File::create(&output)?;
        let entry_size = entry.size();
        std::io::copy(&mut entry.by_ref().take(entry_size), &mut file)?;
    }
    Ok(())
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
}
