use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    process::Stdio,
};

use serde::{Deserialize, Serialize};
use sha1::Sha1;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::source_file::{single_zip_source_index, validate_source_hashes};

use crate::{
    AdapterKind, ChildProcessClass, ChildProcessPolicy, DiscIdentityProfile, HostToolSource,
    HostToolState, HostToolStatus, LaunchKind, LaunchSpec, Library, Platform, PortDefinition,
    PortcoveError, Result, RuntimeSourceMaterialization, SourceKind, SourceProfile, SourceRecord,
};

pub trait Adapter: Send + Sync {
    fn kind(&self) -> AdapterKind;
    fn validate_source(&self, profile: &SourceProfile, path: &Path) -> Result<SourceRecord>;
    fn find_executable(
        &self,
        port: &PortDefinition,
        platform: Platform,
        root: &Path,
    ) -> Result<PathBuf>;
    fn launch_spec(
        &self,
        library: &Library,
        port: &PortDefinition,
        platform: Platform,
        install_root: &Path,
        source: Option<&Path>,
    ) -> Result<LaunchSpec>;
    fn launch_spec_with_executable(
        &self,
        library: &Library,
        port: &PortDefinition,
        platform: Platform,
        install_root: &Path,
        selected_executable: &Path,
        source: Option<&Path>,
    ) -> Result<LaunchSpec>;
}

#[derive(Debug, Clone, Copy)]
struct StandardAdapter(AdapterKind);

impl Adapter for StandardAdapter {
    fn kind(&self) -> AdapterKind {
        self.0
    }

    fn validate_source(&self, profile: &SourceProfile, path: &Path) -> Result<SourceRecord> {
        crate::path::unicode(path, "source")?;
        let absolute = std::path::absolute(path)?;
        let path = absolute.as_path();
        if profile.kind == SourceKind::FileSet {
            return validate_file_set_source(profile, path);
        }
        if profile.kind == SourceKind::PsxDisc {
            return validate_psx_disc_source(profile, path);
        }
        if profile.kind == SourceKind::GamecubeDisc {
            return validate_gamecube_disc_source(profile, path);
        }
        let mut budget = crate::source_file::HashBudget {
            operation: None,
            limit: u64::MAX,
            hashed: 0,
            max_zip_entries: usize::MAX,
        };
        crate::source_file::read_identity(
            path,
            &profile.accepted_extensions,
            u64::MAX,
            &mut budget,
        )?
        .record(profile, path)
    }

    fn find_executable(
        &self,
        port: &PortDefinition,
        platform: Platform,
        root: &Path,
    ) -> Result<PathBuf> {
        let search_root = port
            .runtime_subdirectory
            .as_deref()
            .map(|relative| root.join(relative))
            .unwrap_or_else(|| root.to_path_buf());
        if !search_root.is_dir() || !search_root.starts_with(root) {
            return Err(PortcoveError::launch(format!(
                "runtime subdirectory was not found for {}",
                port.name
            )));
        }
        let files = walk_files(&search_root)?;
        let hints = port
            .executable_hints
            .get(&platform)
            .cloned()
            .unwrap_or_default();
        for hint in &hints {
            if let Some(found) = files.iter().find(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.eq_ignore_ascii_case(hint))
            }) {
                return Ok(found.clone());
            }
        }
        let fallback = files
            .into_iter()
            .find(|path| is_probable_executable(path, platform));
        fallback.ok_or_else(|| {
            PortcoveError::launch(format!(
                "no executable for {} was found under {}",
                port.name,
                root.display()
            ))
        })
    }

    fn launch_spec(
        &self,
        library: &Library,
        port: &PortDefinition,
        platform: Platform,
        install_root: &Path,
        source: Option<&Path>,
    ) -> Result<LaunchSpec> {
        let executable = self.find_executable(port, platform, install_root)?;
        self.launch_spec_with_executable(library, port, platform, install_root, &executable, source)
    }

    fn launch_spec_with_executable(
        &self,
        library: &Library,
        port: &PortDefinition,
        platform: Platform,
        install_root: &Path,
        selected_executable: &Path,
        source: Option<&Path>,
    ) -> Result<LaunchSpec> {
        if !selected_executable.starts_with(install_root) || !selected_executable.is_file() {
            return Err(PortcoveError::verification(
                "selected executable is not a file in the registered install",
            ));
        }
        let executable = selected_executable.to_path_buf();
        let user_data = library.user_dir(&port.id);
        std::fs::create_dir_all(&user_data)?;
        let library_path = crate::path::unicode(library.root(), "library root")?;
        let user_data_path = crate::path::unicode(&user_data, "user data")?;
        let mut environment = BTreeMap::from([
            ("PORTCOVE_LIBRARY".into(), library_path),
            ("PORTCOVE_PORT_ID".into(), port.id.clone()),
            ("PORTCOVE_USER_DATA".into(), user_data_path.clone()),
        ]);
        if let Some(source) = source {
            let source_path = crate::path::unicode(source, "source")?;
            environment.insert("PORTCOVE_SOURCE".into(), source_path.clone());
            if let Some(variable) = &port.source_environment {
                environment.insert(variable.clone(), source_path);
            }
        }
        if self.0 == AdapterKind::GeneratedCache {
            let cache = user_data.join("cache");
            std::fs::create_dir_all(&cache)?;
            environment.insert(
                "PORTCOVE_CACHE".into(),
                crate::path::unicode(&cache, "cache")?,
            );
        }
        if self.0 == AdapterKind::LibultrashipPortable {
            environment.insert("SHIP_HOME".into(), user_data_path.clone());
        }
        let working_directory = if let Some(relative) = &port.runtime_subdirectory {
            let directory = install_root.join(relative);
            if !directory.is_dir() || !executable.starts_with(&directory) {
                return Err(PortcoveError::launch(format!(
                    "runtime subdirectory {} was not found for {}",
                    relative, port.name
                )));
            }
            directory
        } else if port.launch_from_install_root || self.0 == AdapterKind::N64RecompPortable {
            install_root.to_path_buf()
        } else {
            executable.parent().unwrap_or(install_root).to_path_buf()
        };
        if self.0 == AdapterKind::ReferencedDisc {
            let descriptor = serde_json::json!({
                "version": 1,
                "mode": "custom",
                "customPath": user_data_path,
            });
            std::fs::write(
                working_directory.join("data_location.json"),
                serde_json::to_vec_pretty(&descriptor)?,
            )?;
        }
        if self.0 == AdapterKind::N64RecompPortable || port.portable_marker {
            std::fs::write(working_directory.join("portable.txt"), b"")?;
        }
        if self.0 == AdapterKind::PsxRecompManaged
            && let Some(source) = source
        {
            let sources = psx_runtime_source_paths(source)?;
            crate::psx::rewrite_game_discs(&working_directory.join("game.toml"), &sources)?;
        }
        if let (Some(source), Some(filename)) = (source, &port.runtime_source_filename) {
            let stored_source = working_directory.join(filename);
            if let Some(parent) = stored_source.parent() {
                std::fs::create_dir_all(parent)?;
            }
            prepare_runtime_source(
                source,
                &stored_source,
                port.runtime_source_materialization
                    .unwrap_or(RuntimeSourceMaterialization::N64BigEndian),
            )?;
        }
        if self.0 == AdapterKind::UpstreamManagedSetup {
            let source_path = port
                .runtime_source_filename
                .as_ref()
                .map(|filename| working_directory.join(filename));
            run_upstream_setup(port, platform, &working_directory, source_path.as_deref())?;
        }
        if let Some(source) = source {
            for target in &port.runtime_source_set {
                let destination = working_directory.join(&target.destination);
                if let Some(parent) = destination.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                prepare_runtime_source_set_member(
                    source,
                    &target.source_filenames,
                    &destination,
                    target.materialization,
                )?;
            }
        }
        let has_generated_archive = std::fs::read_dir(&user_data)
            .into_iter()
            .flatten()
            .filter_map(std::result::Result::ok)
            .any(|entry| {
                entry
                    .path()
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .is_some_and(|extension| {
                        extension.eq_ignore_ascii_case("o2r")
                            || extension.eq_ignore_ascii_case("otr")
                    })
            });
        let adapter_arguments = match self.0 {
            AdapterKind::ReferencedDisc => match source {
                Some(path) => vec![
                    "--user-dir".into(),
                    user_data_path,
                    "--dvd".into(),
                    crate::path::unicode(path, "source")?,
                ],
                None => Vec::new(),
            },
            AdapterKind::LibultrashipPortable
                if port.runtime_source_filename.is_none() && !has_generated_archive =>
            {
                match source {
                    Some(path) => vec![crate::path::unicode(path, "source")?],
                    None => Vec::new(),
                }
            }
            _ => Vec::new(),
        };
        let mut arguments = port.launch_arguments.clone();
        arguments.extend(adapter_arguments);
        Ok(LaunchSpec {
            launch_kind: LaunchKind::for_executable(&executable),
            executable,
            install_root: install_root.to_path_buf(),
            working_directory,
            environment,
            arguments,
        })
    }
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
struct RuntimeSourceMarker {
    source: String,
    #[serde(default)]
    source_member: Option<String>,
    storage_size: u64,
    modified_unix_nanos: Option<u128>,
    materialization: RuntimeSourceMaterialization,
}

fn prepare_runtime_source(
    source: &Path,
    destination: &Path,
    materialization: RuntimeSourceMaterialization,
) -> Result<()> {
    let marker_path = runtime_source_marker_path(destination)?;
    let expected = runtime_source_marker(source, None, materialization)?;
    let destination_ready = match materialization {
        RuntimeSourceMaterialization::PsxBinCue | RuntimeSourceMaterialization::PsxRawSet => {
            destination.is_dir()
        }
        _ => destination.is_file(),
    };
    let reusable = destination_ready
        && std::fs::read(&marker_path)
            .ok()
            .and_then(|value| serde_json::from_slice::<RuntimeSourceMarker>(&value).ok())
            .as_ref()
            == Some(&expected);
    if reusable {
        return Ok(());
    }

    match materialization {
        RuntimeSourceMaterialization::N64BigEndian => prepare_n64_source(source, destination)?,
        RuntimeSourceMaterialization::Copy => copy_runtime_source(source, destination)?,
        RuntimeSourceMaterialization::GamecubeIso => materialize_gamecube_iso(source, destination)?,
        RuntimeSourceMaterialization::PsxBinCue => materialize_psx_bin_cue(source, destination)?,
        RuntimeSourceMaterialization::PsxRawSet => materialize_psx_raw_set(source, destination)?,
        RuntimeSourceMaterialization::Ps2Iso => materialize_ps2_iso(source, destination)?,
    }
    atomic_write_json(&marker_path, &expected)
}

fn runtime_source_marker(
    source: &Path,
    source_member: Option<String>,
    materialization: RuntimeSourceMaterialization,
) -> Result<RuntimeSourceMarker> {
    let metadata = std::fs::metadata(source)?;
    let modified_unix_nanos = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|value| value.as_nanos());
    let canonical = std::fs::canonicalize(source).unwrap_or_else(|_| source.to_path_buf());
    Ok(RuntimeSourceMarker {
        source: crate::path::unicode(&canonical, "source")?,
        source_member,
        storage_size: metadata.len(),
        modified_unix_nanos,
        materialization,
    })
}

fn prepare_runtime_source_set_member(
    source_root: &Path,
    accepted_filenames: &[String],
    destination: &Path,
    materialization: RuntimeSourceMaterialization,
) -> Result<()> {
    if source_root.is_dir() {
        let member = source_set_member_path(source_root, accepted_filenames)?;
        return prepare_runtime_source(&member, destination, materialization);
    }
    if materialization != RuntimeSourceMaterialization::Copy
        || source_root
            .extension()
            .and_then(|value| value.to_str())
            .is_none_or(|extension| !extension.eq_ignore_ascii_case("zip"))
    {
        return Err(PortcoveError::source(format!(
            "file-set archives only support copied ZIP members: {}",
            source_root.display()
        )));
    }

    let file = File::open(source_root)?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|error| PortcoveError::source(format!("invalid file-set ZIP: {error}")))?;
    let index = source_set_zip_member_index(&mut archive, source_root, accepted_filenames)?;
    let member_name = archive
        .by_index(index)
        .map_err(|error| PortcoveError::source(format!("invalid file-set ZIP entry: {error}")))?
        .name()
        .to_ascii_lowercase();
    let marker_path = runtime_source_marker_path(destination)?;
    let expected = runtime_source_marker(source_root, Some(member_name), materialization)?;
    let reusable = destination.is_file()
        && std::fs::read(&marker_path)
            .ok()
            .and_then(|value| serde_json::from_slice::<RuntimeSourceMarker>(&value).ok())
            .as_ref()
            == Some(&expected);
    if reusable {
        return Ok(());
    }

    const MAX_RUNTIME_SOURCE_BYTES: u64 = 64 * 1024 * 1024 * 1024;
    let mut entry = archive
        .by_index(index)
        .map_err(|error| PortcoveError::source(format!("invalid file-set ZIP entry: {error}")))?;
    if entry.size() > MAX_RUNTIME_SOURCE_BYTES {
        return Err(PortcoveError::source(format!(
            "runtime source exceeds the 64 GiB safety limit: {}",
            source_root.display()
        )));
    }
    let temporary = destination.with_extension(format!("tmp-{}", Uuid::new_v4()));
    let mut output = File::create(&temporary)?;
    std::io::copy(&mut entry, &mut output)?;
    output.sync_all()?;
    replace_atomic(&temporary, destination)?;
    atomic_write_json(&marker_path, &expected)
}

/// Exact core-generated metadata paths, relative to the game's working directory.
/// These are mutable integrity metadata, not persistent user data or arbitrary exclusions.
pub(crate) fn generated_metadata(port: &PortDefinition) -> Result<Vec<String>> {
    let mut paths = Vec::new();
    for destination in port.runtime_source_filename.iter().chain(
        port.runtime_source_set
            .iter()
            .map(|source| &source.destination),
    ) {
        let marker = runtime_source_marker_path(Path::new(destination))?;
        let path = crate::path::unicode(&marker, "source marker")?.replace('\\', "/");
        crate::archive::validate_relative_path(&path, false)?;
        paths.push(path);
    }
    if port.portable_marker || port.adapter == crate::AdapterKind::N64RecompPortable {
        paths.push("portable.txt".into());
    }
    if port.adapter == crate::AdapterKind::ReferencedDisc {
        paths.push("data_location.json".into());
    }
    Ok(paths)
}

fn runtime_source_marker_path(destination: &Path) -> Result<PathBuf> {
    let name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| PortcoveError::state("runtime source destination has no filename"))?;
    Ok(destination.with_file_name(format!("{name}.portcove-source.json")))
}

fn copy_runtime_source(source: &Path, destination: &Path) -> Result<()> {
    const MAX_RUNTIME_SOURCE_BYTES: u64 = 64 * 1024 * 1024 * 1024;
    let temporary = destination.with_extension(format!("tmp-{}", Uuid::new_v4()));
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if extension.eq_ignore_ascii_case("zip") {
        let expected_extension = destination
            .extension()
            .and_then(|value| value.to_str())
            .ok_or_else(|| PortcoveError::state("runtime source destination has no extension"))?;
        let file = File::open(source)?;
        let mut archive = zip::ZipArchive::new(file)
            .map_err(|error| PortcoveError::source(format!("invalid source ZIP: {error}")))?;
        let matches = (0..archive.len())
            .filter(|index| {
                archive.by_index(*index).ok().is_some_and(|entry| {
                    !entry.is_dir()
                        && entry.enclosed_name().is_some_and(|path| {
                            path.extension()
                                .and_then(|value| value.to_str())
                                .is_some_and(|value| value.eq_ignore_ascii_case(expected_extension))
                        })
                })
            })
            .collect::<Vec<_>>();
        if matches.len() != 1 {
            return Err(PortcoveError::source(format!(
                "{} must contain exactly one .{} runtime source",
                source.display(),
                expected_extension
            )));
        }
        let mut entry = archive
            .by_index(matches[0])
            .map_err(|error| PortcoveError::source(format!("invalid source ZIP entry: {error}")))?;
        if entry.size() > MAX_RUNTIME_SOURCE_BYTES {
            return Err(PortcoveError::source(format!(
                "runtime source exceeds the 64 GiB safety limit: {}",
                source.display()
            )));
        }
        let mut output = File::create(&temporary)?;
        std::io::copy(&mut entry, &mut output)?;
        output.sync_all()?;
    } else {
        let size = std::fs::metadata(source)?.len();
        if size > MAX_RUNTIME_SOURCE_BYTES {
            return Err(PortcoveError::source(format!(
                "runtime source exceeds the 64 GiB safety limit: {}",
                source.display()
            )));
        }
        std::fs::copy(source, &temporary)?;
    }
    replace_atomic(&temporary, destination)
}

fn materialize_ps2_iso(source: &Path, destination: &Path) -> Result<()> {
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if extension.eq_ignore_ascii_case("iso") {
        return copy_runtime_source(source, destination);
    }
    if !extension.eq_ignore_ascii_case("chd") {
        return Err(PortcoveError::source(format!(
            "PS2 runtime extraction requires an ISO or CHD source: {}",
            source.display()
        )));
    }
    let temporary = destination.with_extension(format!("tmp-{}.iso", Uuid::new_v4()));
    let program = resolve_chdman()?;
    let output = ChildProcessPolicy::native_command(ChildProcessClass::HostTool, &program)?
        .arg("extractdvd")
        .arg("-i")
        .arg(source)
        .arg("-o")
        .arg(&temporary)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| {
            PortcoveError::source(format!(
                "could not run chdman at {} ({error})",
                program.display()
            ))
        })?;
    if !output.status.success() {
        let _ = std::fs::remove_file(&temporary);
        return Err(PortcoveError::source(format!(
            "chdman could not extract {}: {}",
            source.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    if !temporary.is_file() {
        return Err(PortcoveError::source(
            "chdman completed without producing a PS2 ISO",
        ));
    }
    replace_atomic(&temporary, destination)
}

fn run_upstream_setup(
    port: &PortDefinition,
    platform: Platform,
    working_directory: &Path,
    source: Option<&Path>,
) -> Result<()> {
    let marker = port.setup_marker.as_ref().ok_or_else(|| {
        PortcoveError::state(format!(
            "{} is missing its setup completion marker",
            port.id
        ))
    })?;
    let marker_path = working_directory.join(marker);
    if marker_path.is_file() {
        return Ok(());
    }
    let source = source.ok_or_else(|| {
        PortcoveError::source(format!("{} setup requires a registered source", port.name))
    })?;
    let hints = port.setup_executable_hints.get(&platform).ok_or_else(|| {
        PortcoveError::unsupported(format!("{} has no setup tool for {platform:?}", port.name))
    })?;
    let files = walk_files(working_directory)?;
    let setup = hints
        .iter()
        .find_map(|hint| {
            files.iter().find(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.eq_ignore_ascii_case(hint))
            })
        })
        .ok_or_else(|| {
            PortcoveError::launch(format!(
                "{} setup tool was not found under {}",
                port.name,
                working_directory.display()
            ))
        })?;
    let status = ChildProcessPolicy::native_command(ChildProcessClass::UpstreamSetup, setup)?
        .args(&port.setup_arguments)
        .arg(source)
        .current_dir(working_directory)
        .status()
        .map_err(|error| {
            PortcoveError::launch(format!("could not run {} setup ({error})", port.name))
        })?;
    if !status.success() {
        return Err(PortcoveError::source(format!(
            "{} rejected or could not prepare the registered source (exit {})",
            port.name,
            status.code().unwrap_or(-1)
        )));
    }
    if !marker_path.is_file() {
        return Err(PortcoveError::state(format!(
            "{} setup completed without producing {}",
            port.name, marker
        )));
    }
    Ok(())
}

fn atomic_write_json<T: Serialize>(destination: &Path, value: &T) -> Result<()> {
    let temporary = destination.with_extension(format!("tmp-{}", Uuid::new_v4()));
    std::fs::write(&temporary, serde_json::to_vec_pretty(value)?)?;
    replace_atomic(&temporary, destination)
}

fn replace_atomic(temporary: &Path, destination: &Path) -> Result<()> {
    let backup = destination.with_extension(format!("backup-{}", Uuid::new_v4()));
    let had_destination = destination.exists();
    if had_destination {
        std::fs::rename(destination, &backup)?;
    }
    if let Err(error) = std::fs::rename(temporary, destination) {
        let _ = std::fs::remove_file(temporary);
        if had_destination && std::fs::rename(&backup, destination).is_err() {
            return Err(PortcoveError::state(format!(
                "failed to replace {} and could not restore its backup at {}: {error}",
                destination.display(),
                backup.display()
            )));
        }
        return Err(error.into());
    }
    if had_destination {
        std::fs::remove_file(backup)?;
    }
    Ok(())
}

fn materialize_psx_bin_cue(source: &Path, destination: &Path) -> Result<()> {
    if source
        .extension()
        .and_then(|value| value.to_str())
        .is_none_or(|extension| !extension.eq_ignore_ascii_case("chd"))
    {
        return Err(PortcoveError::source(format!(
            "PS1 runtime extraction requires a CHD source: {}",
            source.display()
        )));
    }
    let parent = destination
        .parent()
        .ok_or_else(|| PortcoveError::state("PS1 runtime destination has no parent directory"))?;
    std::fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".portcove-psx-{}", Uuid::new_v4()));
    if let Err(error) = materialize_psx_chd(source, &temporary) {
        let _ = std::fs::remove_dir_all(&temporary);
        return Err(error);
    }
    replace_directory_transactional(&temporary, destination)
}

fn materialize_psx_raw_set(source: &Path, destination: &Path) -> Result<()> {
    if !source.is_dir() {
        return Err(PortcoveError::source(format!(
            "multi-disc PS1 runtime extraction requires a CHD directory: {}",
            source.display()
        )));
    }
    let sources = psx_runtime_source_paths(source)?;
    if sources.len() < 2 {
        return Err(PortcoveError::source(format!(
            "multi-disc PS1 runtime extraction requires at least two CHDs: {}",
            source.display()
        )));
    }
    let parent = destination
        .parent()
        .ok_or_else(|| PortcoveError::state("PS1 runtime destination has no parent directory"))?;
    std::fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".portcove-psx-set-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&temporary)?;
    let materialized = (|| {
        for (index, source) in sources.iter().enumerate() {
            let extracted = temporary.join(format!(".disc-{:02}", index + 1));
            let cue = materialize_psx_chd(source, &extracted)?;
            let (_, data_track) = inspect_psx_cue(&cue)?;
            let destination = temporary.join(format!("disc-{:02}.bin", index + 1));
            std::fs::rename(&data_track, &destination)?;
            std::fs::remove_dir_all(&extracted)?;
        }
        Ok(())
    })();
    if let Err(error) = materialized {
        let _ = std::fs::remove_dir_all(&temporary);
        return Err(error);
    }
    replace_directory_transactional(&temporary, destination)
}

fn replace_directory_transactional(temporary: &Path, destination: &Path) -> Result<()> {
    let parent = destination
        .parent()
        .ok_or_else(|| PortcoveError::state("runtime source directory has no parent directory"))?;
    if temporary.parent() != Some(parent) || !temporary.is_dir() {
        return Err(PortcoveError::state(
            "runtime source directory replacement has an invalid staging path",
        ));
    }
    let backup = parent.join(format!(".portcove-backup-{}", Uuid::new_v4()));
    let had_destination = destination.exists();
    if had_destination {
        if !destination.is_dir() {
            return Err(PortcoveError::state(format!(
                "runtime source destination is not a directory: {}",
                destination.display()
            )));
        }
        std::fs::rename(destination, &backup)?;
    }
    if let Err(error) = std::fs::rename(temporary, destination) {
        let _ = std::fs::remove_dir_all(temporary);
        if had_destination && std::fs::rename(&backup, destination).is_err() {
            return Err(PortcoveError::state(format!(
                "failed to replace {} and could not restore its backup at {}: {error}",
                destination.display(),
                backup.display()
            )));
        }
        return Err(error.into());
    }
    if had_destination {
        std::fs::remove_dir_all(backup)?;
    }
    Ok(())
}

fn prepare_n64_source(source: &Path, destination: &Path) -> Result<()> {
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if !["z64", "v64", "n64", "zip"]
        .iter()
        .any(|candidate| candidate.eq_ignore_ascii_case(extension))
    {
        return Err(PortcoveError::source(format!(
            "unsupported N64 ROM extension: {}",
            source.display()
        )));
    }

    let mut rom = if extension.eq_ignore_ascii_case("zip") {
        read_zip_source(source, &["z64", "v64", "n64"], 512 * 1024 * 1024)?
    } else {
        std::fs::read(source)?
    };
    if rom.len() < 4 {
        return Err(PortcoveError::source(format!(
            "N64 ROM is too short: {}",
            source.display()
        )));
    }
    let padding = (4 - rom.len() % 4) % 4;
    rom.resize(rom.len() + padding, 0);

    match rom[..4] {
        [0x80, 0x37, 0x12, 0x40] => {}
        [0x37, 0x80, 0x40, 0x12] => {
            for pair in rom.as_chunks_mut::<2>().0 {
                pair.swap(0, 1);
            }
        }
        [0x40, 0x12, 0x37, 0x80] => {
            for word in rom.as_chunks_mut::<4>().0 {
                word.reverse();
            }
        }
        _ => {
            return Err(PortcoveError::source(format!(
                "unrecognized N64 ROM byte order: {}",
                source.display()
            )));
        }
    }

    let temporary = destination.with_extension(format!("tmp-{}", Uuid::new_v4()));
    std::fs::write(&temporary, rom)?;
    replace_atomic(&temporary, destination)
}

#[derive(Debug, Default, Clone, Copy)]
pub struct AdapterRegistry;

impl AdapterRegistry {
    pub fn get(&self, kind: AdapterKind) -> Box<dyn Adapter> {
        Box::new(StandardAdapter(kind))
    }
}

pub(crate) fn hash_file(path: &Path) -> Result<(String, u64)> {
    hash_file_with_checkpoint(path, || Ok(()))
}

pub(crate) fn hash_file_with_checkpoint(
    path: &Path,
    mut checkpoint: impl FnMut() -> Result<()>,
) -> Result<(String, u64)> {
    let mut file = File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 128 * 1024];
    let mut size = 0_u64;
    loop {
        checkpoint()?;
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
        size += read as u64;
    }
    Ok((hex::encode(digest.finalize()), size))
}

fn hash_file_sha1(path: &Path) -> Result<String> {
    let mut file = File::open(path)?;
    let mut digest = Sha1::new();
    let mut buffer = [0_u8; 128 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(hex::encode(digest.finalize()))
}

fn validate_file_set_source(profile: &SourceProfile, path: &Path) -> Result<SourceRecord> {
    let is_zip = path.is_file()
        && path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"));
    if !path.is_dir() && !is_zip {
        return Err(PortcoveError::source(format!(
            "{} expects a directory or ZIP file set: {}",
            profile.label,
            path.display()
        )));
    }
    let mut archive = if is_zip {
        Some(
            zip::ZipArchive::new(File::open(path)?)
                .map_err(|error| PortcoveError::source(format!("invalid file-set ZIP: {error}")))?,
        )
    } else {
        None
    };
    let mut hashes = Vec::with_capacity(profile.members.len());
    let mut total_size = 0_u64;
    for member in &profile.members {
        let (sha256, sha1, crc32, size) = if let Some(archive) = archive.as_mut() {
            let index = source_set_zip_member_index(archive, path, &member.accepted_filenames)?;
            let mut entry = archive.by_index(index).map_err(|error| {
                PortcoveError::source(format!("invalid file-set ZIP entry: {error}"))
            })?;
            let crc32 = format!("{:08x}", entry.crc32());
            let size = entry.size();
            let mut sha256 = Sha256::new();
            let mut sha1 = Sha1::new();
            let mut buffer = [0_u8; 128 * 1024];
            loop {
                let read = entry.read(&mut buffer)?;
                if read == 0 {
                    break;
                }
                sha256.update(&buffer[..read]);
                sha1.update(&buffer[..read]);
            }
            (
                hex::encode(sha256.finalize()),
                hex::encode(sha1.finalize()),
                crc32,
                size,
            )
        } else {
            let source = source_set_member_path(path, &member.accepted_filenames)?;
            let (sha256, size) = hash_file(&source)?;
            let sha1 = if member.accepted_sha1.is_empty() {
                String::new()
            } else {
                hash_file_sha1(&source)?
            };
            let crc32 = if member.accepted_crc32.is_empty() {
                String::new()
            } else {
                hash_file_crc32(&source)?
            };
            (sha256, sha1, crc32, size)
        };
        if !member.accepted_sha1.is_empty()
            && !member
                .accepted_sha1
                .iter()
                .any(|expected| expected.eq_ignore_ascii_case(&sha1))
        {
            return Err(PortcoveError::source(format!(
                "source hash is not a supported {} variant",
                member.label
            ))
            .detail("member", member.id.clone())
            .detail("sha1", sha1));
        }
        if !member.accepted_sha256.is_empty()
            && !member
                .accepted_sha256
                .iter()
                .any(|expected| expected.eq_ignore_ascii_case(&sha256))
        {
            return Err(PortcoveError::source(format!(
                "source hash is not a supported {} variant",
                member.label
            ))
            .detail("member", member.id.clone())
            .detail("sha256", sha256));
        }
        if !member.accepted_crc32.is_empty()
            && !member
                .accepted_crc32
                .iter()
                .any(|expected| expected.eq_ignore_ascii_case(&crc32))
        {
            return Err(PortcoveError::source(format!(
                "source CRC32 is not a supported {} variant",
                member.label
            ))
            .detail("member", member.id.clone())
            .detail("crc32", crc32));
        }
        hashes.push(format!("{}:{sha256}", member.id));
        total_size = total_size.saturating_add(size);
    }
    let identity = aggregate_sha256(&hashes);
    let (storage_sha256, storage_size) = if is_zip {
        hash_file(path)?
    } else {
        (identity.clone(), total_size)
    };
    Ok(SourceRecord {
        profile_id: profile.id.clone(),
        path: path.to_path_buf(),
        sha256: identity.clone(),
        size: total_size,
        storage_sha256,
        storage_size,
        updated_at: Library::now(),
    })
}

fn source_set_zip_member_index(
    archive: &mut zip::ZipArchive<File>,
    archive_path: &Path,
    accepted_filenames: &[String],
) -> Result<usize> {
    let mut matches = Vec::new();
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(|error| {
            PortcoveError::source(format!("invalid file-set ZIP entry: {error}"))
        })?;
        let Some(path) = entry.enclosed_name() else {
            continue;
        };
        if entry.is_dir() || path.components().count() != 1 {
            continue;
        }
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if accepted_filenames
            .iter()
            .any(|candidate| candidate.eq_ignore_ascii_case(name))
        {
            matches.push(index);
        }
    }
    if matches.len() != 1 {
        return Err(PortcoveError::source(format!(
            "{} must contain exactly one top-level ZIP member named one of: {}",
            archive_path.display(),
            accepted_filenames.join(", ")
        )));
    }
    Ok(matches[0])
}

fn hash_file_crc32(path: &Path) -> Result<String> {
    let mut file = File::open(path)?;
    let mut digest = crc32fast::Hasher::new();
    let mut buffer = [0_u8; 128 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:08x}", digest.finalize()))
}

fn source_set_member_path(root: &Path, accepted_filenames: &[String]) -> Result<PathBuf> {
    if !root.is_dir() {
        return Err(PortcoveError::source(format!(
            "file-set source is not a directory: {}",
            root.display()
        )));
    }
    let mut matches = Vec::new();
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_symlink() || !file_type.is_file() {
            continue;
        }
        let name = entry.file_name().into_string().map_err(|_| {
            PortcoveError::unsupported(
                "Portcove V1 requires source member paths to be valid Unicode",
            )
            .detail("path_role", "source member")
        })?;
        if accepted_filenames
            .iter()
            .any(|candidate| candidate.eq_ignore_ascii_case(&name))
        {
            matches.push(entry.path());
        }
    }
    if matches.len() != 1 {
        return Err(PortcoveError::source(format!(
            "{} must contain exactly one of: {}",
            root.display(),
            accepted_filenames.join(", ")
        )));
    }
    Ok(matches.remove(0))
}

fn validate_psx_disc_source(profile: &SourceProfile, path: &Path) -> Result<SourceRecord> {
    let disc = profile.disc.as_ref().ok_or_else(|| {
        PortcoveError::state(format!("{} is missing its disc identity", profile.id))
    })?;
    let paths = psx_source_paths(path, disc.discs.len().max(1))?;
    let temporary_parent = std::env::var_os("PORTCOVE_TEMP_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    std::fs::create_dir_all(&temporary_parent)?;
    let temporary = tempfile::Builder::new()
        .prefix("portcove-psx-")
        .tempdir_in(temporary_parent)
        .map_err(PortcoveError::from)?;
    let mut normalized_sha256 = Vec::new();
    let mut normalized_size = 0_u64;
    for (index, source) in paths.iter().enumerate() {
        let output = temporary.path().join(format!("disc-{:02}", index + 1));
        let cue = materialize_psx_chd(source, &output)?;
        let (track_count, data_track) = inspect_psx_cue(&cue)?;
        let identity = disc.discs.get(index);
        let track_counts = identity
            .map(|entry| entry.track_counts.as_slice())
            .unwrap_or(&disc.track_counts);
        if !track_counts.contains(&track_count) {
            let label = identity
                .map(|entry| entry.label.as_str())
                .unwrap_or(&profile.label);
            return Err(PortcoveError::source(format!(
                "{label} has {track_count} tracks; expected one of {track_counts:?}"
            )));
        }
        let (sha256, size) = hash_file(&data_track)?;
        let needs_sha1 = identity.is_some_and(|entry| !entry.accepted_sha1.is_empty())
            || (identity.is_none() && !profile.accepted_sha1.is_empty());
        let sha1 = if needs_sha1 {
            hash_file_sha1(&data_track)?
        } else {
            String::new()
        };
        let volume_id = inspect_psx_volume_id(&data_track)?;
        if let Some(identity) = identity {
            validate_disc_identity(identity, &sha1, &sha256, &volume_id)?;
        } else {
            validate_source_hashes(profile, &sha1, &sha256)?;
        }
        normalized_sha256.push(sha256);
        normalized_size = normalized_size.saturating_add(size);
    }
    let sha256 = aggregate_sha256(&normalized_sha256);
    let (storage_sha256, storage_size) = source_storage_identity(path)?;
    Ok(SourceRecord {
        profile_id: profile.id.clone(),
        path: path.to_path_buf(),
        sha256,
        size: normalized_size,
        storage_sha256,
        storage_size,
        updated_at: Library::now(),
    })
}

fn validate_gamecube_disc_source(profile: &SourceProfile, path: &Path) -> Result<SourceRecord> {
    if !path.is_file() {
        return Err(PortcoveError::source(format!(
            "GameCube source does not exist or is not a file: {}",
            path.display()
        )));
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !profile
        .accepted_extensions
        .iter()
        .any(|candidate| candidate.eq_ignore_ascii_case(&extension))
    {
        return Err(PortcoveError::source(format!(
            "{} expects one of: {}",
            profile.label,
            profile.accepted_extensions.join(", ")
        )));
    }

    let (sha256, sha1, size) = if matches!(extension.as_str(), "iso" | "gcm") {
        let (sha256, size) = hash_file(path)?;
        (sha256, hash_file_sha1(path)?, size)
    } else {
        let temporary_parent = std::env::var_os("PORTCOVE_TEMP_DIR")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        std::fs::create_dir_all(&temporary_parent)?;
        let temporary = tempfile::Builder::new()
            .prefix("portcove-gamecube-")
            .tempdir_in(temporary_parent)
            .map_err(PortcoveError::from)?;
        let iso = temporary.path().join("disc.iso");
        materialize_gamecube_iso(path, &iso)?;
        let (sha256, size) = hash_file(&iso)?;
        (sha256, hash_file_sha1(&iso)?, size)
    };
    validate_source_hashes(profile, &sha1, &sha256)?;
    let (storage_sha256, storage_size) = hash_file(path)?;
    Ok(SourceRecord {
        profile_id: profile.id.clone(),
        path: path.to_path_buf(),
        sha256,
        size,
        storage_sha256,
        storage_size,
        updated_at: Library::now(),
    })
}

fn materialize_gamecube_iso(source: &Path, destination: &Path) -> Result<()> {
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if matches!(extension.to_ascii_lowercase().as_str(), "iso" | "gcm") {
        return copy_runtime_source(source, destination);
    }
    if !["rvz", "ciso", "gcz", "wia"]
        .iter()
        .any(|candidate| candidate.eq_ignore_ascii_case(extension))
    {
        return Err(PortcoveError::source(format!(
            "unsupported GameCube disc extension: {}",
            source.display()
        )));
    }

    let program = resolve_dolphin_tool()?;
    let temporary = destination.with_extension(format!("tmp-{}.iso", Uuid::new_v4()));
    let output = ChildProcessPolicy::native_command(ChildProcessClass::HostTool, &program)?
        .arg("convert")
        .arg("-i")
        .arg(source)
        .arg("-o")
        .arg(&temporary)
        .arg("-f")
        .arg("iso")
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| {
            PortcoveError::source(format!(
                "could not run DolphinTool at {} ({error})",
                program.display()
            ))
            .detail("dolphin_tool_path", program.display().to_string())
        })?;
    if !output.status.success() {
        let _ = std::fs::remove_file(&temporary);
        let detail = String::from_utf8_lossy(&output.stderr);
        return Err(PortcoveError::source(format!(
            "DolphinTool could not convert {}: {}",
            source.display(),
            detail.trim()
        )));
    }
    if !temporary.is_file() {
        return Err(PortcoveError::source(
            "DolphinTool completed without producing an ISO",
        ));
    }
    replace_atomic(&temporary, destination)
}

fn resolve_dolphin_tool() -> Result<PathBuf> {
    resolve_host_tool(
        "PORTCOVE_DOLPHIN_TOOL",
        "dolphin_tool_path",
        "DolphinTool was not found; install Dolphin or set PORTCOVE_DOLPHIN_TOOL to its full path",
        "set PORTCOVE_DOLPHIN_TOOL to the full DolphinTool executable path",
        "Portcove checks PATH, its own directory, DOLPHIN_HOME, and launcher-provided RetroBat paths",
        dolphin_tool_candidates(),
    )
}

fn dolphin_tool_candidates() -> Vec<PathBuf> {
    let executable_names: &[&str] = if cfg!(windows) {
        &["DolphinTool.exe"]
    } else {
        &["dolphin-tool", "DolphinTool"]
    };
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path) {
            for name in executable_names {
                push_unique_path(&mut candidates, directory.join(name));
            }
        }
    }
    if let Ok(executable) = std::env::current_exe()
        && let Some(directory) = executable.parent()
    {
        for name in executable_names {
            push_unique_path(&mut candidates, directory.join(name));
        }
    }
    if let Some(root) = std::env::var_os("DOLPHIN_HOME").filter(|value| !value.is_empty()) {
        for name in executable_names {
            push_unique_path(&mut candidates, PathBuf::from(&root).join(name));
        }
    }
    if let Some(root) = std::env::var_os("RETROBAT_ROOT").filter(|value| !value.is_empty()) {
        for name in executable_names {
            push_unique_path(
                &mut candidates,
                PathBuf::from(&root)
                    .join("emulators")
                    .join("dolphin-emu")
                    .join(name),
            );
        }
    }
    #[cfg(unix)]
    for path in [
        "/usr/bin/dolphin-tool",
        "/usr/local/bin/dolphin-tool",
        "/app/bin/dolphin-tool",
    ] {
        push_unique_path(&mut candidates, PathBuf::from(path));
    }
    #[cfg(target_os = "macos")]
    for path in [
        "/opt/homebrew/bin/dolphin-tool",
        "/Applications/Dolphin.app/Contents/MacOS/DolphinTool",
    ] {
        push_unique_path(&mut candidates, PathBuf::from(path));
    }
    candidates
}

pub(crate) fn psx_source_paths(path: &Path, expected_count: usize) -> Result<Vec<PathBuf>> {
    let mut paths = if path.is_file() {
        vec![path.to_path_buf()]
    } else if path.is_dir() {
        std::fs::read_dir(path)?
            .filter_map(std::result::Result::ok)
            .map(|entry| entry.path())
            .filter(|candidate| {
                candidate.is_file()
                    && candidate
                        .extension()
                        .and_then(|value| value.to_str())
                        .is_some_and(|extension| extension.eq_ignore_ascii_case("chd"))
            })
            .collect()
    } else {
        return Err(PortcoveError::source(format!(
            "PS1 source does not exist: {}",
            path.display()
        )));
    };
    for path in &paths {
        crate::path::unicode(path, "source member")?;
    }
    paths.sort_by_key(|candidate| {
        candidate
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase()
    });
    if paths.len() != expected_count {
        return Err(PortcoveError::source(format!(
            "PS1 source requires {expected_count} CHD file(s); found {} under {}",
            paths.len(),
            path.display()
        )));
    }
    Ok(paths)
}

pub(crate) fn psx_runtime_source_paths(path: &Path) -> Result<Vec<PathBuf>> {
    let expected_count = if path.is_file() {
        1
    } else if path.is_dir() {
        std::fs::read_dir(path)?
            .filter_map(std::result::Result::ok)
            .filter(|entry| {
                entry.path().is_file()
                    && entry
                        .path()
                        .extension()
                        .and_then(|value| value.to_str())
                        .is_some_and(|extension| extension.eq_ignore_ascii_case("chd"))
            })
            .count()
    } else {
        0
    };
    psx_source_paths(path, expected_count)
}

pub(crate) fn source_storage_identity(path: &Path) -> Result<(String, u64)> {
    if path.is_file() {
        return hash_file(path);
    }
    let paths = psx_source_paths(
        path,
        std::fs::read_dir(path)?
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry.path().is_file()
                    && entry
                        .path()
                        .extension()
                        .and_then(|value| value.to_str())
                        .is_some_and(|extension| extension.eq_ignore_ascii_case("chd"))
            })
            .count(),
    )?;
    let mut hashes = Vec::new();
    let mut size = 0_u64;
    for source in paths {
        let (sha256, source_size) = hash_file(&source)?;
        hashes.push(sha256);
        size = size.saturating_add(source_size);
    }
    Ok((aggregate_sha256(&hashes), size))
}

pub(crate) fn verify_source_storage_identity(source: &SourceRecord, role: &str) -> Result<()> {
    let (actual_sha256, actual_size) = source_storage_identity(&source.path)?;
    if actual_sha256 != source.storage_sha256 || actual_size != source.storage_size {
        return Err(PortcoveError::source(format!(
            "{role} changed after verification: {}",
            source.path.display()
        ))
        .detail("profile_id", &source.profile_id)
        .detail("recorded_storage_sha256", &source.storage_sha256)
        .detail("actual_storage_sha256", actual_sha256)
        .detail("recorded_storage_size", source.storage_size.to_string())
        .detail("actual_storage_size", actual_size.to_string()));
    }
    Ok(())
}

fn aggregate_sha256(hashes: &[String]) -> String {
    if let [only] = hashes {
        return only.clone();
    }
    let mut digest = Sha256::new();
    for hash in hashes {
        digest.update(hash.as_bytes());
        digest.update([0]);
    }
    hex::encode(digest.finalize())
}

fn validate_disc_identity(
    identity: &DiscIdentityProfile,
    sha1: &str,
    sha256: &str,
    volume_id: &str,
) -> Result<()> {
    if !identity.accepted_sha1.is_empty()
        && !identity
            .accepted_sha1
            .iter()
            .any(|expected| expected.eq_ignore_ascii_case(sha1))
    {
        return Err(PortcoveError::source(format!(
            "source hash is not a supported {} variant",
            identity.label
        ))
        .detail("sha1", sha1));
    }
    if !identity.accepted_sha256.is_empty()
        && !identity
            .accepted_sha256
            .iter()
            .any(|expected| expected.eq_ignore_ascii_case(sha256))
    {
        return Err(PortcoveError::source(format!(
            "source hash is not a supported {} variant",
            identity.label
        ))
        .detail("sha256", sha256));
    }
    if !identity.accepted_volume_ids.is_empty()
        && !identity
            .accepted_volume_ids
            .iter()
            .any(|expected| expected.eq_ignore_ascii_case(volume_id))
    {
        return Err(PortcoveError::source(format!(
            "source volume is not a supported {} variant",
            identity.label
        ))
        .detail("volume_id", volume_id));
    }
    Ok(())
}

pub(crate) fn materialize_psx_chd(source: &Path, destination: &Path) -> Result<PathBuf> {
    std::fs::create_dir_all(destination)?;
    let cue = destination.join("disc.cue");
    let bins = destination.join("disc%t.bin");
    let program = resolve_chdman()?;
    let output = ChildProcessPolicy::native_command(ChildProcessClass::HostTool, &program)?
        .arg("extractcd")
        .arg("-i")
        .arg(source)
        .arg("-o")
        .arg(&cue)
        .arg("-ob")
        .arg(&bins)
        .arg("-sb")
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| {
            PortcoveError::source(format!(
                "could not run chdman at {} ({error})",
                program.display()
            ))
            .detail("chdman_path", program.display().to_string())
        })?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        return Err(PortcoveError::source(format!(
            "chdman could not extract {}: {}",
            source.display(),
            detail.trim()
        )));
    }
    if !cue.is_file() {
        return Err(PortcoveError::source(
            "chdman completed without producing a cue sheet",
        ));
    }
    Ok(cue)
}

fn resolve_chdman() -> Result<PathBuf> {
    resolve_host_tool(
        "PORTCOVE_CHDMAN",
        "chdman_path",
        "chdman was not found; install MAME or set PORTCOVE_CHDMAN to its full path",
        "set PORTCOVE_CHDMAN to the full chdman executable path",
        "Portcove checks PATH, its own directory, MAME_HOME, and known Batocera, EmuDeck, and RetroBat locations",
        chdman_candidates(),
    )
}

fn chdman_candidates() -> Vec<PathBuf> {
    let executable_name = if cfg!(windows) {
        "chdman.exe"
    } else {
        "chdman"
    };
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path) {
            push_unique_path(&mut candidates, directory.join(executable_name));
        }
    }
    if let Ok(executable) = std::env::current_exe()
        && let Some(directory) = executable.parent()
    {
        push_unique_path(&mut candidates, directory.join(executable_name));
    }
    if let Some(root) = std::env::var_os("MAME_HOME").filter(|value| !value.is_empty()) {
        push_unique_path(&mut candidates, PathBuf::from(root).join(executable_name));
    }
    if let Some(root) = std::env::var_os("RETROBAT_ROOT").filter(|value| !value.is_empty()) {
        let root = PathBuf::from(root);
        push_unique_path(
            &mut candidates,
            root.join("emulators").join("mame").join(executable_name),
        );
        push_unique_path(
            &mut candidates,
            root.join("system").join("tools").join(executable_name),
        );
    }

    #[cfg(windows)]
    if let Some(app_data) = std::env::var_os("APPDATA").filter(|value| !value.is_empty()) {
        push_unique_path(
            &mut candidates,
            PathBuf::from(app_data)
                .join("EmuDeck")
                .join("backend")
                .join("tools")
                .join("chdconv")
                .join(executable_name),
        );
    }
    #[cfg(unix)]
    {
        push_unique_path(&mut candidates, PathBuf::from("/usr/bin/mame/chdman"));
        push_unique_path(&mut candidates, PathBuf::from("/usr/bin/chdman"));
        push_unique_path(&mut candidates, PathBuf::from("/usr/local/bin/chdman"));
        if let Some(home) = std::env::var_os("HOME").filter(|value| !value.is_empty()) {
            push_unique_path(
                &mut candidates,
                PathBuf::from(home).join(".config/EmuDeck/backend/tools/chdconv/chdman"),
            );
        }
    }
    #[cfg(target_os = "macos")]
    {
        push_unique_path(&mut candidates, PathBuf::from("/opt/homebrew/bin/chdman"));
        push_unique_path(&mut candidates, PathBuf::from("/Applications/MAME/chdman"));
    }
    candidates
}

fn push_unique_path(paths: &mut Vec<PathBuf>, candidate: PathBuf) {
    if !paths.iter().any(|path| path == &candidate) {
        paths.push(candidate);
    }
}

#[derive(Debug)]
struct HostToolDiscovery {
    state: HostToolState,
    path: Option<PathBuf>,
    source: Option<HostToolSource>,
    searched_paths: Vec<PathBuf>,
}

fn discover_host_tool(configured: Option<OsString>, candidates: Vec<PathBuf>) -> HostToolDiscovery {
    if let Some(configured) = configured {
        let path = PathBuf::from(configured);
        return HostToolDiscovery {
            state: if path.is_file() {
                HostToolState::Available
            } else {
                HostToolState::Misconfigured
            },
            path: Some(path),
            source: Some(HostToolSource::Environment),
            searched_paths: Vec::new(),
        };
    }
    let path = candidates
        .iter()
        .find(|candidate| candidate.is_file())
        .cloned();
    let source = path.as_ref().map(|_| HostToolSource::Discovery);
    HostToolDiscovery {
        state: if path.is_some() {
            HostToolState::Available
        } else {
            HostToolState::Missing
        },
        path,
        source,
        searched_paths: candidates,
    }
}

fn resolve_host_tool(
    configuration_variable: &str,
    path_detail: &str,
    missing_message: &str,
    configured_setup_hint: &str,
    missing_setup_hint: &str,
    candidates: Vec<PathBuf>,
) -> Result<PathBuf> {
    let discovery = discover_host_tool(
        std::env::var_os(configuration_variable).filter(|value| !value.is_empty()),
        candidates,
    );
    match discovery.state {
        HostToolState::Available => Ok(discovery.path.expect("available host tool has a path")),
        HostToolState::Misconfigured => {
            let path = discovery
                .path
                .expect("misconfigured host tool has a configured path");
            Err(PortcoveError::source(format!(
                "{configuration_variable} does not point to a file: {}",
                path.display()
            ))
            .detail(path_detail, path.display().to_string())
            .detail("setup_hint", configured_setup_hint))
        }
        HostToolState::Missing => {
            let searched = discovery
                .searched_paths
                .iter()
                .map(|candidate| candidate.display().to_string())
                .collect::<Vec<_>>()
                .join(";");
            Err(PortcoveError::source(missing_message)
                .detail("searched_paths", searched)
                .detail("setup_hint", missing_setup_hint))
        }
    }
}

fn host_tool_status(
    id: &str,
    configuration_variable: &str,
    purpose: &str,
    candidates: Vec<PathBuf>,
) -> HostToolStatus {
    let discovery = discover_host_tool(
        std::env::var_os(configuration_variable).filter(|value| !value.is_empty()),
        candidates,
    );
    HostToolStatus {
        id: id.into(),
        state: discovery.state,
        path: discovery.path,
        source: discovery.source,
        configuration_variable: configuration_variable.into(),
        purpose: purpose.into(),
    }
}

pub(crate) fn host_tool_statuses() -> Vec<HostToolStatus> {
    vec![
        host_tool_status(
            "chdman",
            "PORTCOVE_CHDMAN",
            "CHD validation and disc-image materialization",
            chdman_candidates(),
        ),
        host_tool_status(
            "dolphin_tool",
            "PORTCOVE_DOLPHIN_TOOL",
            "compressed GameCube validation and ISO materialization",
            dolphin_tool_candidates(),
        ),
    ]
}

fn inspect_psx_cue(cue: &Path) -> Result<(u32, PathBuf)> {
    let body = std::fs::read_to_string(cue)?;
    let track_count = body
        .lines()
        .filter(|line| line.trim_start().starts_with("TRACK "))
        .count() as u32;
    let first_file = body
        .lines()
        .find_map(|line| {
            let line = line.trim();
            let value = line.strip_prefix("FILE ")?.trim();
            value
                .strip_prefix('"')?
                .split_once('"')
                .map(|(name, _)| name)
        })
        .ok_or_else(|| PortcoveError::source("cue sheet has no FILE entry"))?;
    let relative = Path::new(first_file);
    if relative
        .components()
        .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err(PortcoveError::source(
            "cue sheet contains an unsafe FILE path",
        ));
    }
    let data_track = cue.parent().unwrap_or_else(|| Path::new("")).join(relative);
    if !data_track.is_file() {
        return Err(PortcoveError::source(format!(
            "cue data track does not exist: {}",
            data_track.display()
        )));
    }
    Ok((track_count, data_track))
}

fn inspect_psx_volume_id(data_track: &Path) -> Result<String> {
    const PVD_SECTOR: u64 = 16;
    const VOLUME_ID_OFFSET: u64 = 40;
    let size = std::fs::metadata(data_track)?.len();
    let layouts = [(2352_u64, 24_u64), (2352, 16), (2048, 0)];
    let mut file = File::open(data_track)?;
    for (sector_size, data_offset) in layouts {
        let offset = PVD_SECTOR * sector_size + data_offset;
        if size < offset + 72 {
            continue;
        }
        file.seek(SeekFrom::Start(offset))?;
        let mut descriptor = [0_u8; 72];
        file.read_exact(&mut descriptor)?;
        if descriptor[0] != 1 || &descriptor[1..6] != b"CD001" || descriptor[6] != 1 {
            continue;
        }
        let value = String::from_utf8_lossy(
            &descriptor[VOLUME_ID_OFFSET as usize..VOLUME_ID_OFFSET as usize + 32],
        )
        .trim_matches(['\0', ' '])
        .to_string();
        if !value.is_empty() {
            return Ok(value);
        }
    }
    Err(PortcoveError::source(format!(
        "PS1 data track has no readable ISO 9660 volume identity: {}",
        data_track.display()
    )))
}

fn read_zip_source(
    path: &Path,
    accepted_extensions: &[&str],
    maximum_size: u64,
) -> Result<Vec<u8>> {
    let file = File::open(path)?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|error| PortcoveError::source(format!("invalid source ZIP: {error}")))?;
    let accepted: Vec<String> = accepted_extensions
        .iter()
        .map(|value| (*value).into())
        .collect();
    let index = single_zip_source_index(&mut archive, &accepted)?;
    let mut entry = archive
        .by_index(index)
        .map_err(|error| PortcoveError::source(format!("invalid source ZIP entry: {error}")))?;
    if entry.size() > maximum_size {
        return Err(PortcoveError::source(
            "compressed cartridge source exceeds its safety limit",
        ));
    }
    let mut bytes = Vec::with_capacity(entry.size() as usize);
    entry
        .by_ref()
        .take(maximum_size + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > maximum_size {
        return Err(PortcoveError::source(
            "compressed cartridge source exceeds its safety limit",
        ));
    }
    Ok(bytes)
}

pub(crate) fn walk_files(root: &Path) -> Result<Vec<PathBuf>> {
    fn visit(directory: &Path, files: &mut Vec<PathBuf>) -> std::io::Result<()> {
        for entry in std::fs::read_dir(directory)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                visit(&entry.path(), files)?;
            }
            if kind.is_file() {
                files.push(entry.path());
            }
        }
        Ok(())
    }
    let mut files = Vec::new();
    visit(root, &mut files)?;
    Ok(files)
}

fn is_probable_executable(path: &Path, platform: Platform) -> bool {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if ["uninstall", "updater", "crashpad"]
        .iter()
        .any(|value| name.contains(value))
    {
        return false;
    }
    match platform {
        Platform::WindowsX86_64 => name.ends_with(".exe"),
        Platform::LinuxX86_64 => {
            if name.ends_with(".appimage") {
                return true;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                path.metadata()
                    .is_ok_and(|metadata| metadata.permissions().mode() & 0o111 != 0)
            }
            #[cfg(not(unix))]
            {
                false
            }
        }
        Platform::MacosX86_64 | Platform::MacosAarch64 => path
            .components()
            .any(|component| component.as_os_str() == "MacOS"),
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write as _;

    use super::*;
    use crate::Catalog;

    #[test]
    fn chdman_candidate_selection_is_ordered_and_ignores_missing_files() {
        let temporary = tempfile::tempdir().unwrap();
        let missing = temporary.path().join("missing-chdman");
        let available = temporary.path().join("available-chdman");
        std::fs::write(&available, b"test").unwrap();
        let discovery = discover_host_tool(None, vec![missing, available.clone()]);

        assert_eq!(discovery.state, HostToolState::Available);
        assert_eq!(discovery.path, Some(available));
        assert_eq!(discovery.source, Some(HostToolSource::Discovery));
    }

    #[test]
    fn explicit_missing_host_tool_is_reported_as_misconfigured() {
        let temporary = tempfile::tempdir().unwrap();
        let configured = temporary.path().join("missing-tool");
        let fallback = temporary.path().join("available-tool");
        std::fs::write(&fallback, b"test").unwrap();

        let discovery =
            discover_host_tool(Some(configured.clone().into_os_string()), vec![fallback]);

        assert_eq!(discovery.state, HostToolState::Misconfigured);
        assert_eq!(discovery.path, Some(configured));
        assert_eq!(discovery.source, Some(HostToolSource::Environment));
    }

    #[test]
    fn chdman_candidate_paths_are_deduplicated() {
        let mut candidates = Vec::new();
        push_unique_path(&mut candidates, PathBuf::from("chdman"));
        push_unique_path(&mut candidates, PathBuf::from("chdman"));

        assert_eq!(candidates, vec![PathBuf::from("chdman")]);
    }

    #[test]
    fn source_validation_supports_upstream_sha1_allowlists() {
        let temporary = tempfile::tempdir_in(std::env::current_dir().unwrap()).unwrap();
        let source = temporary.path().join("game.z64");
        let relative = Path::new(temporary.path().file_name().unwrap()).join("game.z64");
        std::fs::write(&source, b"source").unwrap();
        let mut profile = SourceProfile {
            id: "sha1-test".into(),
            label: "SHA-1 test source".into(),
            accepted_extensions: vec!["z64".into()],
            accepted_sha1: vec!["828d338a9b04221c9cbe286f50cd389f68de4ecf".into()],
            accepted_sha256: Vec::new(),
            kind: crate::SourceKind::File,
            disc: None,
            members: Vec::new(),
        };

        let validated = AdapterRegistry
            .get(AdapterKind::N64RecompPortable)
            .validate_source(&profile, &relative)
            .unwrap();
        assert_eq!(validated.path, source);

        profile.accepted_sha1 = vec!["0".repeat(40)];
        let error = AdapterRegistry
            .get(AdapterKind::N64RecompPortable)
            .validate_source(&profile, &source)
            .unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::SourceInvalid);
    }

    #[test]
    fn single_file_zip_sources_are_verified_and_materialized() {
        let temporary = tempfile::tempdir().unwrap();
        let source = temporary.path().join("game.zip");
        let rom = [0x80, 0x37, 0x12, 0x40, 1, 2, 3, 4];
        let file = File::create(&source).unwrap();
        let mut archive = zip::ZipWriter::new(file);
        archive
            .start_file("nested/game.z64", zip::write::SimpleFileOptions::default())
            .unwrap();
        archive.write_all(&rom).unwrap();
        archive.finish().unwrap();
        let profile = SourceProfile {
            id: "zip-test".into(),
            label: "ZIP test source".into(),
            accepted_extensions: vec!["z64".into()],
            accepted_sha1: vec![hex::encode(Sha1::digest(rom))],
            accepted_sha256: vec![hex::encode(Sha256::digest(rom))],
            kind: crate::SourceKind::File,
            disc: None,
            members: Vec::new(),
        };

        let record = AdapterRegistry
            .get(AdapterKind::N64RecompPortable)
            .validate_source(&profile, &source)
            .unwrap();
        assert_eq!(record.path, source);
        assert_eq!(record.size, rom.len() as u64);

        let destination = temporary.path().join("materialized.z64");
        prepare_n64_source(&record.path, &destination).unwrap();
        assert_eq!(std::fs::read(destination).unwrap(), rom);
    }

    #[test]
    fn libultraship_launches_with_source_and_persistent_ship_home() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let install = temporary.path().join("install");
        std::fs::create_dir_all(&install).unwrap();
        std::fs::write(install.join("Lighthouse.exe"), b"test").unwrap();
        let source = temporary.path().join("banjo.z64");
        std::fs::write(&source, b"source").unwrap();
        let catalog = Catalog::embedded().unwrap();
        let port = catalog.port("lighthouse").unwrap();

        let spec = AdapterRegistry
            .get(AdapterKind::LibultrashipPortable)
            .launch_spec(
                &library,
                port,
                Platform::WindowsX86_64,
                &install,
                Some(&source),
            )
            .unwrap();

        assert_eq!(spec.arguments, vec![source.to_string_lossy()]);
        let expected_ship_home = library
            .user_dir("lighthouse")
            .to_string_lossy()
            .into_owned();
        assert_eq!(spec.environment.get("SHIP_HOME"), Some(&expected_ship_home));

        std::fs::write(library.user_dir("lighthouse").join("bk.o2r"), b"archive").unwrap();
        let next_spec = AdapterRegistry
            .get(AdapterKind::LibultrashipPortable)
            .launch_spec(
                &library,
                port,
                Platform::WindowsX86_64,
                &install,
                Some(&source),
            )
            .unwrap();
        assert!(next_spec.arguments.is_empty());
    }

    #[test]
    fn referenced_disc_launches_with_the_upstream_dvd_argument() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let install = temporary.path().join("install");
        std::fs::create_dir_all(&install).unwrap();
        std::fs::write(install.join("dusklight.exe"), b"test").unwrap();
        let source = temporary.path().join("twilight-princess.rvz");
        std::fs::write(&source, b"source").unwrap();
        let catalog = Catalog::embedded().unwrap();
        let port = catalog.port("dusklight").unwrap();

        let spec = AdapterRegistry
            .get(AdapterKind::ReferencedDisc)
            .launch_spec(
                &library,
                port,
                Platform::WindowsX86_64,
                &install,
                Some(&source),
            )
            .unwrap();

        assert_eq!(
            spec.arguments,
            vec![
                "--user-dir",
                library.user_dir("dusklight").to_string_lossy().as_ref(),
                "--dvd",
                source.to_string_lossy().as_ref(),
            ]
        );
        let descriptor = std::fs::read_to_string(install.join("data_location.json")).unwrap();
        let descriptor: serde_json::Value = serde_json::from_str(&descriptor).unwrap();
        assert_eq!(descriptor["version"], 1);
        assert_eq!(descriptor["mode"], "custom");
        assert_eq!(
            descriptor["customPath"],
            library.user_dir("dusklight").to_string_lossy().as_ref()
        );
    }

    #[test]
    fn n64_recomp_enables_portable_storage_beside_the_executable() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let install = temporary.path().join("install");
        std::fs::create_dir_all(&install).unwrap();
        std::fs::write(install.join("Zelda64Recompiled.exe"), b"test").unwrap();
        let source = temporary.path().join("majora.z64");
        let canonical = [0x80, 0x37, 0x12, 0x40, 1, 2, 3, 4];
        std::fs::write(&source, canonical).unwrap();
        let catalog = Catalog::embedded().unwrap();
        let port = catalog.port("zelda64-recomp").unwrap();

        AdapterRegistry
            .get(AdapterKind::N64RecompPortable)
            .launch_spec(
                &library,
                port,
                Platform::WindowsX86_64,
                &install,
                Some(&source),
            )
            .unwrap();

        assert!(install.join("portable.txt").is_file());
        assert_eq!(
            std::fs::read(install.join("mm.n64.us.1.0.z64")).unwrap(),
            canonical
        );
    }

    #[test]
    fn libultraship_can_stage_a_runtime_source_for_auto_detection() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let install = temporary.path().join("install");
        std::fs::create_dir_all(&install).unwrap();
        std::fs::write(install.join("Spaghettify.exe"), b"test").unwrap();
        let source = temporary.path().join("mario-kart.z64");
        let canonical = [0x80, 0x37, 0x12, 0x40, 1, 2, 3, 4];
        std::fs::write(&source, canonical).unwrap();
        let catalog = Catalog::embedded().unwrap();
        let port = catalog.port("spaghetti-kart").unwrap();

        let spec = AdapterRegistry
            .get(AdapterKind::LibultrashipPortable)
            .launch_spec(
                &library,
                port,
                Platform::WindowsX86_64,
                &install,
                Some(&source),
            )
            .unwrap();

        assert!(spec.arguments.is_empty());
        assert_eq!(
            std::fs::read(install.join("baserom.us.z64")).unwrap(),
            canonical
        );
    }

    #[test]
    fn n64_runtime_sources_are_normalized_to_big_endian() {
        let temporary = tempfile::tempdir().unwrap();
        let canonical = [0x80, 0x37, 0x12, 0x40, 1, 2, 3, 4];
        let variants = [
            ("game.z64", canonical),
            ("game.v64", [0x37, 0x80, 0x40, 0x12, 2, 1, 4, 3]),
            ("game.n64", [0x40, 0x12, 0x37, 0x80, 4, 3, 2, 1]),
        ];

        for (index, (name, bytes)) in variants.into_iter().enumerate() {
            let source = temporary.path().join(name);
            let destination = temporary.path().join(format!("stored-{index}.z64"));
            std::fs::write(&source, bytes).unwrap();
            prepare_n64_source(&source, &destination).unwrap();
            assert_eq!(std::fs::read(destination).unwrap(), canonical);
        }
    }

    #[test]
    fn copied_runtime_sources_are_replaced_when_registration_changes() {
        let temporary = tempfile::tempdir().unwrap();
        let first = temporary.path().join("first.gba");
        let second = temporary.path().join("second.gba");
        let destination = temporary.path().join("runtime/baserom.gba");
        std::fs::create_dir_all(destination.parent().unwrap()).unwrap();
        std::fs::write(&first, b"first source").unwrap();
        std::fs::write(&second, b"replacement source").unwrap();

        prepare_runtime_source(&first, &destination, RuntimeSourceMaterialization::Copy).unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), b"first source");

        prepare_runtime_source(&second, &destination, RuntimeSourceMaterialization::Copy).unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), b"replacement source");
        let marker = std::fs::read(runtime_source_marker_path(&destination).unwrap()).unwrap();
        let marker: RuntimeSourceMarker = serde_json::from_slice(&marker).unwrap();
        assert_eq!(
            marker.source,
            std::fs::canonicalize(second)
                .unwrap()
                .to_string_lossy()
                .as_ref()
        );
    }

    #[test]
    fn ps2_iso_sources_are_copied_without_conversion() {
        let temporary = tempfile::tempdir().unwrap();
        let source = temporary.path().join("retail.iso");
        let destination = temporary.path().join("runtime/source.iso");
        std::fs::create_dir_all(destination.parent().unwrap()).unwrap();
        std::fs::write(&source, b"direct ps2 iso").unwrap();

        prepare_runtime_source(&source, &destination, RuntimeSourceMaterialization::Ps2Iso)
            .unwrap();

        assert_eq!(std::fs::read(&destination).unwrap(), b"direct ps2 iso");
        assert!(runtime_source_marker_path(&destination).unwrap().is_file());
    }

    #[test]
    fn file_set_sources_require_every_exact_member() {
        let temporary = tempfile::tempdir().unwrap();
        let first = temporary.path().join("first.bin");
        let second = temporary.path().join("second.rom");
        std::fs::write(&first, b"first").unwrap();
        std::fs::write(&second, b"second").unwrap();
        let profile = SourceProfile {
            id: "set-test".into(),
            label: "Set test".into(),
            accepted_extensions: Vec::new(),
            accepted_sha1: Vec::new(),
            accepted_sha256: Vec::new(),
            kind: SourceKind::FileSet,
            disc: None,
            members: vec![
                crate::SourceMemberProfile {
                    id: "first".into(),
                    label: "First member".into(),
                    accepted_filenames: vec!["first.bin".into()],
                    accepted_sha1: Vec::new(),
                    accepted_sha256: vec![hex::encode(Sha256::digest(b"first"))],
                    accepted_crc32: Vec::new(),
                },
                crate::SourceMemberProfile {
                    id: "second".into(),
                    label: "Second member".into(),
                    accepted_filenames: vec!["second.rom".into()],
                    accepted_sha1: vec![hex::encode(Sha1::digest(b"second"))],
                    accepted_sha256: Vec::new(),
                    accepted_crc32: Vec::new(),
                },
            ],
        };

        let record = AdapterRegistry
            .get(AdapterKind::StagedSourcePortable)
            .validate_source(&profile, temporary.path())
            .unwrap();
        assert_eq!(record.size, 11);

        std::fs::write(second, b"changed").unwrap();
        let error = AdapterRegistry
            .get(AdapterKind::StagedSourcePortable)
            .validate_source(&profile, temporary.path())
            .unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::SourceInvalid);
        assert_eq!(
            error.details.get("member").map(String::as_str),
            Some("second")
        );
    }

    #[test]
    fn file_set_runtime_targets_stage_each_declared_member() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let install = temporary.path().join("install");
        let source = temporary.path().join("source");
        std::fs::create_dir_all(&install).unwrap();
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(install.join("tmc_pc.exe"), b"test").unwrap();
        std::fs::write(source.join("game.bin"), b"game").unwrap();
        std::fs::write(source.join("audio.rom"), b"audio").unwrap();
        let catalog = Catalog::embedded().unwrap();
        let mut port = catalog.port("project-picori").unwrap().clone();
        port.runtime_source_filename = None;
        port.runtime_source_materialization = None;
        port.runtime_source_set = vec![
            crate::RuntimeSourceTarget {
                source_filenames: vec!["game.bin".into()],
                destination: "data/game.bin".into(),
                materialization: RuntimeSourceMaterialization::Copy,
            },
            crate::RuntimeSourceTarget {
                source_filenames: vec!["audio.rom".into()],
                destination: "data/audio.rom".into(),
                materialization: RuntimeSourceMaterialization::Copy,
            },
        ];

        AdapterRegistry
            .get(AdapterKind::StagedSourcePortable)
            .launch_spec(
                &library,
                &port,
                Platform::WindowsX86_64,
                &install,
                Some(&source),
            )
            .unwrap();

        assert_eq!(
            std::fs::read(install.join("data/game.bin")).unwrap(),
            b"game"
        );
        assert_eq!(
            std::fs::read(install.join("data/audio.rom")).unwrap(),
            b"audio"
        );
    }

    #[test]
    fn zipped_file_sets_validate_crc32_and_stage_declared_members() {
        let temporary = tempfile::tempdir().unwrap();
        let archive_path = temporary.path().join("arcade.zip");
        let file = File::create(&archive_path).unwrap();
        let mut archive = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        archive.start_file("game.rom", options).unwrap();
        archive.write_all(b"game").unwrap();
        archive.start_file("audio.rom", options).unwrap();
        archive.write_all(b"audio").unwrap();
        archive.finish().unwrap();
        let profile = SourceProfile {
            id: "arcade-set-test".into(),
            label: "Arcade set test".into(),
            accepted_extensions: Vec::new(),
            accepted_sha1: Vec::new(),
            accepted_sha256: Vec::new(),
            kind: SourceKind::FileSet,
            disc: None,
            members: vec![
                crate::SourceMemberProfile {
                    id: "game".into(),
                    label: "Game ROM".into(),
                    accepted_filenames: vec!["game.rom".into()],
                    accepted_sha1: Vec::new(),
                    accepted_sha256: Vec::new(),
                    accepted_crc32: vec![format!("{:08x}", crc32fast::hash(b"game"))],
                },
                crate::SourceMemberProfile {
                    id: "audio".into(),
                    label: "Audio ROM".into(),
                    accepted_filenames: vec!["audio.rom".into()],
                    accepted_sha1: Vec::new(),
                    accepted_sha256: Vec::new(),
                    accepted_crc32: vec![format!("{:08x}", crc32fast::hash(b"audio"))],
                },
            ],
        };
        let record = AdapterRegistry
            .get(AdapterKind::StagedSourcePortable)
            .validate_source(&profile, &archive_path)
            .unwrap();
        assert_eq!(record.size, 9);
        assert_eq!(
            record.storage_size,
            std::fs::metadata(&archive_path).unwrap().len()
        );

        let library = Library::open(temporary.path().join("library")).unwrap();
        let install = temporary.path().join("install");
        std::fs::create_dir_all(&install).unwrap();
        std::fs::write(install.join("tmc_pc.exe"), b"test").unwrap();
        let catalog = Catalog::embedded().unwrap();
        let mut port = catalog.port("project-picori").unwrap().clone();
        port.runtime_source_filename = None;
        port.runtime_source_materialization = None;
        port.runtime_source_set = vec![
            crate::RuntimeSourceTarget {
                source_filenames: vec!["game.rom".into()],
                destination: "roms/game.rom".into(),
                materialization: RuntimeSourceMaterialization::Copy,
            },
            crate::RuntimeSourceTarget {
                source_filenames: vec!["audio.rom".into()],
                destination: "roms/audio.rom".into(),
                materialization: RuntimeSourceMaterialization::Copy,
            },
        ];
        AdapterRegistry
            .get(AdapterKind::StagedSourcePortable)
            .launch_spec(
                &library,
                &port,
                Platform::WindowsX86_64,
                &install,
                Some(&archive_path),
            )
            .unwrap();
        assert_eq!(
            std::fs::read(install.join("roms/game.rom")).unwrap(),
            b"game"
        );
        assert_eq!(
            std::fs::read(install.join("roms/audio.rom")).unwrap(),
            b"audio"
        );
    }

    #[test]
    fn runtime_source_directories_replace_transactionally() {
        let temporary = tempfile::tempdir().unwrap();
        let destination = temporary.path().join("diskimages");
        let staged = temporary.path().join("staged");
        std::fs::create_dir_all(&destination).unwrap();
        std::fs::create_dir_all(&staged).unwrap();
        std::fs::write(destination.join("old.bin"), b"old").unwrap();
        std::fs::write(staged.join("disc.cue"), b"new cue").unwrap();
        std::fs::write(staged.join("disc1.bin"), b"new track").unwrap();

        replace_directory_transactional(&staged, &destination).unwrap();

        assert!(!staged.exists());
        assert!(!destination.join("old.bin").exists());
        assert_eq!(
            std::fs::read(destination.join("disc.cue")).unwrap(),
            b"new cue"
        );
        assert_eq!(
            std::fs::read(destination.join("disc1.bin")).unwrap(),
            b"new track"
        );
    }

    #[test]
    fn psx_volume_identity_supports_raw_mode2_and_iso_sectors() {
        let temporary = tempfile::tempdir().unwrap();
        for (name, sector_size, data_offset) in
            [("mode2.bin", 2352_u64, 24_u64), ("disc.iso", 2048, 0)]
        {
            let path = temporary.path().join(name);
            let mut image = vec![0_u8; (16 * sector_size + data_offset + 72) as usize];
            let descriptor = (16 * sector_size + data_offset) as usize;
            image[descriptor] = 1;
            image[descriptor + 1..descriptor + 6].copy_from_slice(b"CD001");
            image[descriptor + 6] = 1;
            image[descriptor + 40..descriptor + 49].copy_from_slice(b"SCUS94491");
            std::fs::write(&path, image).unwrap();

            assert_eq!(inspect_psx_volume_id(&path).unwrap(), "SCUS94491");
        }
    }

    #[test]
    fn n64_recomp_uses_the_managed_root_for_bundled_executables() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let install = temporary.path().join("install");
        let executable_root = install.join("Zelda.app/Contents/MacOS");
        std::fs::create_dir_all(&executable_root).unwrap();
        std::fs::write(executable_root.join("zelda64recompiled"), b"test").unwrap();
        let catalog = Catalog::embedded().unwrap();
        let port = catalog.port("zelda64-recomp").unwrap();

        let spec = AdapterRegistry
            .get(AdapterKind::N64RecompPortable)
            .launch_spec(&library, port, Platform::MacosAarch64, &install, None)
            .unwrap();

        assert_eq!(spec.working_directory, install);
        assert!(spec.working_directory.join("portable.txt").is_file());
    }

    #[test]
    fn catalog_runtime_subdirectory_keeps_portable_data_beside_nested_executable() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let install = temporary.path().join("install");
        let runtime = install.join("BeetleRecomp-Windows-x64");
        std::fs::create_dir_all(&runtime).unwrap();
        std::fs::write(runtime.join("BeetleRecomp.exe"), b"test").unwrap();
        let source = temporary.path().join("beetle.z64");
        let canonical = [0x80, 0x37, 0x12, 0x40, 1, 2, 3, 4];
        std::fs::write(&source, canonical).unwrap();
        let catalog = Catalog::embedded().unwrap();
        let port = catalog.port("beetle-recomp").unwrap();

        let spec = AdapterRegistry
            .get(AdapterKind::N64RecompPortable)
            .launch_spec(
                &library,
                port,
                Platform::WindowsX86_64,
                &install,
                Some(&source),
            )
            .unwrap();

        assert_eq!(spec.working_directory, runtime);
        assert!(spec.working_directory.join("portable.txt").is_file());
        assert_eq!(
            std::fs::read(spec.working_directory.join("bar.n64.us.z64")).unwrap(),
            canonical
        );
        assert!(!install.join("portable.txt").exists());
    }

    #[test]
    fn generated_cache_can_use_a_catalog_declared_import_contract() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let install = temporary.path().join("install");
        std::fs::create_dir_all(&install).unwrap();
        std::fs::write(install.join("gen1recomp.exe"), b"test").unwrap();
        let source = temporary.path().join("pokemon-red.gb");
        std::fs::write(&source, b"source").unwrap();
        let catalog = Catalog::embedded().unwrap();
        let port = catalog.port("gen1recomp").unwrap();

        let spec = AdapterRegistry
            .get(AdapterKind::GeneratedCache)
            .launch_spec(
                &library,
                port,
                Platform::WindowsX86_64,
                &install,
                Some(&source),
            )
            .unwrap();

        assert_eq!(spec.arguments, vec!["--game=red"]);
        assert_eq!(
            spec.environment.get("POKEPORT_IMPORT_ROM"),
            Some(&source.to_string_lossy().into_owned())
        );
        assert!(install.join("portable.txt").is_file());
    }

    #[test]
    fn generated_cache_can_stage_a_nested_runtime_source() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let install = temporary.path().join("install");
        std::fs::create_dir_all(&install).unwrap();
        std::fs::write(install.join("pd.x86_64.exe"), b"test").unwrap();
        let source = temporary.path().join("perfect-dark.z64");
        let canonical = [0x80, 0x37, 0x12, 0x40, 1, 2, 3, 4];
        std::fs::write(&source, canonical).unwrap();
        let catalog = Catalog::embedded().unwrap();
        let port = catalog.port("perfect-dark").unwrap();

        let spec = AdapterRegistry
            .get(AdapterKind::GeneratedCache)
            .launch_spec(
                &library,
                port,
                Platform::WindowsX86_64,
                &install,
                Some(&source),
            )
            .unwrap();

        assert_eq!(spec.arguments, vec!["--portable"]);
        assert_eq!(
            std::fs::read(install.join("data/pd.ntsc-final.z64")).unwrap(),
            canonical
        );
    }
}
