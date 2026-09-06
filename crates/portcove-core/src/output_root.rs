use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{Library, PortcoveError, Result, library::OutputRootRecord};

const MARKER_NAME: &str = ".portcove-game-output.json";
const MARKER_LIMIT: u64 = 16 * 1024;

#[derive(Debug, Clone)]
pub(crate) struct PreparedOutputRoot {
    pub root: PathBuf,
    pub operation_root: PathBuf,
}

#[derive(Debug, Clone)]
pub(crate) struct RemovalPaths {
    pub live: PathBuf,
    pub quarantined: PathBuf,
    pub cleanup_root: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct OutputRootMarker {
    schema_version: u32,
    library_id: String,
    port_id: String,
    marker_id: String,
    output_root: PathBuf,
    volume_identity: String,
}

pub(crate) fn prepare_for_install(
    library: &Library,
    port_id: &str,
    requested_root: &Path,
    operation_id: &str,
    required_bytes: u64,
) -> Result<PreparedOutputRoot> {
    Uuid::parse_str(operation_id)
        .map_err(|_| PortcoveError::state("invalid install operation identity"))?;
    crate::path::refuse_symlink_ancestors(requested_root)?;
    let requested_root = crate::path::normalized_absolute(requested_root, "game output root")?;
    let default_root = crate::path::normalized_absolute(
        &library.versions_dir().join(port_id),
        "default game output root",
    )?;
    if requested_root == default_root {
        require_capacity(library.root(), required_bytes)?;
        return Ok(PreparedOutputRoot {
            root: requested_root,
            operation_root: library.staging_dir().join(operation_id),
        });
    }

    validate_external_path(library, port_id, &requested_root)?;
    let capacity_path = crate::path::existing_ancestor(&requested_root)?;
    require_capacity(&capacity_path, required_bytes)?;

    match fs::symlink_metadata(&requested_root) {
        Ok(metadata) => {
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err(PortcoveError::conflict(
                    "game output root must be a real directory",
                ));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(&requested_root)?;
        }
        Err(error) => return Err(error.into()),
    }
    crate::path::refuse_symlink_ancestors(&requested_root)?;
    let canonical = fs::canonicalize(&requested_root)?;
    if canonical != requested_root {
        return Err(PortcoveError::conflict(
            "game output root changed identity while it was being claimed",
        ));
    }

    let current_volume = volume_identity(&canonical)?;
    match library.output_root(&canonical)? {
        Some(record) => {
            recover_missing_marker(library, port_id, &record, &current_volume)?;
            validate_claim(library, port_id, &record, &current_volume)?;
        }
        None => claim(library, port_id, &canonical, &current_volume)?,
    }
    require_capacity(&canonical, required_bytes)?;
    Ok(PreparedOutputRoot {
        operation_root: canonical.join(".staging").join(operation_id),
        root: canonical,
    })
}

pub(crate) fn validate_staging_path(
    library: &Library,
    port_id: &str,
    operation_id: &str,
    staging: &Path,
) -> Result<()> {
    Uuid::parse_str(operation_id)
        .map_err(|_| PortcoveError::state("invalid install operation identity"))?;
    crate::path::refuse_symlink_ancestors(staging)?;
    let default = library.staging_dir().join(operation_id);
    if staging == default {
        validate_private_directory_parent(library.staging_dir(), staging)?;
        return Ok(());
    }
    let record = library
        .output_roots()?
        .into_iter()
        .find(|record| {
            record.port_id == port_id && record.path.join(".staging").join(operation_id) == staging
        })
        .ok_or_else(|| PortcoveError::conflict("private staging path is not owned by this port"))?;
    let current_volume = volume_identity(&record.path)?;
    validate_marker(library, port_id, &record, &current_volume)?;
    validate_private_directory_parent(record.path.join(".staging"), staging)
}

fn validate_private_directory_parent(parent: PathBuf, path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            let canonical_parent = fs::canonicalize(parent)?;
            if !metadata.is_dir()
                || metadata.file_type().is_symlink()
                || fs::canonicalize(path)?.parent() != Some(canonical_parent.as_path())
            {
                return Err(PortcoveError::conflict(
                    "private staging directory changed identity",
                ));
            }
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

pub(crate) fn validate_install_path(
    library: &Library,
    port_id: &str,
    install_path: &Path,
) -> Result<PathBuf> {
    crate::path::refuse_symlink_ancestors(install_path)?;
    let install_path = fs::canonicalize(install_path)?;
    let default_parent = fs::canonicalize(library.versions_dir().join(port_id))?;
    if install_path.parent() == Some(default_parent.as_path()) {
        return Ok(install_path);
    }
    let parent = install_path
        .parent()
        .ok_or_else(|| PortcoveError::conflict("registered install path has no output root"))?;
    let record = library
        .output_root(parent)?
        .filter(|record| record.port_id == port_id)
        .ok_or_else(|| {
            PortcoveError::conflict("registered install path is outside an owned output root")
        })?;
    let current_volume = volume_identity(parent)?;
    validate_claim(library, port_id, &record, &current_volume)?;
    Ok(install_path)
}

pub(crate) fn removal_paths(
    library: &Library,
    port_id: &str,
    operation_id: &str,
    install_path: &Path,
) -> Result<RemovalPaths> {
    crate::path::refuse_symlink_ancestors(install_path)?;
    let live = crate::path::resolve_existing_ancestor(install_path)?;
    let name = live
        .file_name()
        .ok_or_else(|| PortcoveError::conflict("registered install path has no version name"))?
        .to_owned();
    let parent = live
        .parent()
        .ok_or_else(|| PortcoveError::conflict("registered install path has no output root"))?;
    let default_parent =
        crate::path::resolve_existing_ancestor(&library.versions_dir().join(port_id))?;
    let (cleanup_root, quarantine_parent) = if parent == default_parent {
        let cleanup = library.recovery_dir().join(operation_id);
        (cleanup.clone(), cleanup.join(port_id))
    } else {
        let record = library
            .output_root(parent)?
            .filter(|record| record.port_id == port_id)
            .ok_or_else(|| {
                PortcoveError::conflict("registered install path is outside an owned output root")
            })?;
        let current_volume = volume_identity(parent)?;
        validate_marker(library, port_id, &record, &current_volume)?;
        let cleanup = parent.join(".recovery").join(operation_id);
        (cleanup.clone(), cleanup)
    };
    Ok(RemovalPaths {
        live,
        quarantined: quarantine_parent.join(name),
        cleanup_root,
    })
}

fn validate_external_path(library: &Library, port_id: &str, root: &Path) -> Result<()> {
    crate::path::refuse_symlink_ancestors(root)?;
    if root.parent().is_none() {
        return Err(PortcoveError::conflict(
            "a filesystem root cannot be used as a game output folder",
        ));
    }
    let library_root = crate::path::resolve_existing_ancestor(library.root())?;
    if overlaps(root, &library_root) {
        return Err(PortcoveError::conflict(
            "a custom game output folder cannot overlap the Portcove library",
        ));
    }
    for source in library.sources()? {
        let source = crate::path::resolve_existing_ancestor(&source.path)?;
        if overlaps(root, &source) {
            return Err(PortcoveError::conflict(
                "game output folder cannot overlap a registered original source",
            ));
        }
    }
    for record in library.output_roots()? {
        if record.path != root && overlaps(root, &record.path) {
            return Err(PortcoveError::conflict(format!(
                "game output folder overlaps the managed output for {}",
                record.port_id
            )));
        }
        if record.path == root && record.port_id != port_id {
            return Err(PortcoveError::conflict(format!(
                "game output folder is owned by {}",
                record.port_id
            )));
        }
    }
    reject_system_path(root)
}

fn claim(library: &Library, port_id: &str, root: &Path, volume: &str) -> Result<()> {
    if fs::read_dir(root)?.next().transpose()?.is_some() {
        return Err(PortcoveError::conflict(
            "game output folder is nonempty and is not registered to this library and port",
        ));
    }
    let marker_id = Uuid::new_v4().to_string();
    let record = OutputRootRecord {
        path: root.to_path_buf(),
        port_id: port_id.to_owned(),
        marker_id,
        volume_identity: volume.to_owned(),
    };
    library.register_output_root(&record)?;
    write_marker(library, &record)
}

fn write_marker(library: &Library, record: &OutputRootRecord) -> Result<()> {
    let marker = OutputRootMarker {
        schema_version: 1,
        library_id: library.identity()?,
        port_id: record.port_id.clone(),
        marker_id: record.marker_id.clone(),
        output_root: record.path.clone(),
        volume_identity: record.volume_identity.clone(),
    };
    let marker_path = record.path.join(MARKER_NAME);
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&marker_path)?;
    serde_json::to_writer_pretty(&mut file, &marker)?;
    use std::io::Write;
    file.write_all(b"\n")?;
    file.sync_all()?;
    Ok(())
}

fn recover_missing_marker(
    library: &Library,
    port_id: &str,
    record: &OutputRootRecord,
    current_volume: &str,
) -> Result<()> {
    let marker_path = record.path.join(MARKER_NAME);
    match fs::symlink_metadata(&marker_path) {
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if record.port_id != port_id || record.volume_identity != current_volume {
                return Err(PortcoveError::conflict(
                    "incomplete output-root claim no longer matches its authoritative metadata",
                ));
            }
            if fs::read_dir(&record.path)?.next().transpose()?.is_some() {
                return Err(PortcoveError::conflict(
                    "output-root marker is missing and unowned data is present",
                ));
            }
            write_marker(library, record)
        }
        Err(error) => Err(error.into()),
    }
}

fn validate_claim(
    library: &Library,
    port_id: &str,
    record: &OutputRootRecord,
    current_volume: &str,
) -> Result<()> {
    validate_marker(library, port_id, record, current_volume)?;
    for entry in fs::read_dir(&record.path)? {
        let entry = entry?;
        let name = entry.file_name();
        if name != MARKER_NAME && name != ".staging" && name != ".recovery" {
            let path = entry.path();
            let registered = library
                .all_installs()?
                .iter()
                .any(|install| install.port_id == port_id && install.path == path);
            if !registered {
                return Err(PortcoveError::conflict(
                    "game output folder contains data not owned by Portcove",
                )
                .detail("path", path.display().to_string()));
            }
        }
    }
    Ok(())
}

fn validate_marker(
    library: &Library,
    port_id: &str,
    record: &OutputRootRecord,
    current_volume: &str,
) -> Result<()> {
    let marker_path = record.path.join(MARKER_NAME);
    let bytes = crate::path::read_bounded_regular(&marker_path, MARKER_LIMIT)?;
    let marker: OutputRootMarker = serde_json::from_slice(&bytes).map_err(|error| {
        PortcoveError::verification("game output ownership marker is invalid")
            .detail("cause", error.to_string())
    })?;
    if marker.schema_version != 1
        || marker.library_id != library.identity()?
        || marker.port_id != port_id
        || marker.marker_id != record.marker_id
        || marker.output_root != record.path
        || marker.volume_identity != record.volume_identity
    {
        return Err(PortcoveError::conflict(
            "game output marker does not agree with authoritative library metadata",
        ));
    }
    if current_volume != record.volume_identity {
        return Err(PortcoveError::conflict(
            "game output folder is now on a different filesystem volume",
        ));
    }
    Ok(())
}

fn require_capacity(path: &Path, required_bytes: u64) -> Result<()> {
    let available = fs2::available_space(path)?;
    if available < required_bytes {
        return Err(PortcoveError::install(
            "game output volume does not have enough available space",
        )
        .detail("required_bytes", required_bytes.to_string())
        .detail("available_bytes", available.to_string())
        .detail("capacity_path", path.display().to_string()));
    }
    Ok(())
}

fn overlaps(left: &Path, right: &Path) -> bool {
    left.starts_with(right) || right.starts_with(left)
}

#[cfg(windows)]
fn reject_system_path(path: &Path) -> Result<()> {
    for variable in ["SystemRoot", "ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(value) = std::env::var_os(variable) {
            let protected = crate::path::resolve_existing_ancestor(Path::new(&value))?;
            if overlaps(path, &protected) {
                return Err(PortcoveError::conflict(
                    "game output folder overlaps a protected system location",
                ));
            }
        }
    }
    Ok(())
}

#[cfg(not(windows))]
fn reject_system_path(path: &Path) -> Result<()> {
    const PROTECTED: &[&str] = &[
        "bin", "boot", "dev", "etc", "lib", "proc", "root", "run", "sbin", "sys", "usr", "var",
        "System", "Library",
    ];
    let filesystem_root = PathBuf::from(std::path::MAIN_SEPARATOR.to_string());
    if PROTECTED
        .iter()
        .any(|name| overlaps(path, &filesystem_root.join(name)))
    {
        return Err(PortcoveError::conflict(
            "game output folder overlaps a protected system location",
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn volume_identity(path: &Path) -> Result<String> {
    use std::os::unix::fs::MetadataExt;
    Ok(format!("unix-dev:{}", fs::metadata(path)?.dev()))
}

#[cfg(windows)]
fn volume_identity(path: &Path) -> Result<String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{GetVolumeInformationW, GetVolumePathNameW};

    let input = path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let mut volume_path = vec![0_u16; 32_768];
    let found = unsafe {
        GetVolumePathNameW(
            input.as_ptr(),
            volume_path.as_mut_ptr(),
            volume_path.len() as u32,
        )
    };
    if found == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let mut serial = 0_u32;
    let found = unsafe {
        GetVolumeInformationW(
            volume_path.as_ptr(),
            std::ptr::null_mut(),
            0,
            &mut serial,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0,
        )
    };
    if found == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(format!("windows-volume:{serial:08x}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_root_claim_is_port_and_library_bound() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let root = temporary.path().join("game-output");

        let prepared =
            prepare_for_install(&library, "sample", &root, &Uuid::new_v4().to_string(), 0).unwrap();
        assert_eq!(prepared.root, fs::canonicalize(&root).unwrap());
        assert!(root.join(MARKER_NAME).is_file());
        let record = library.output_root(&prepared.root).unwrap().unwrap();
        assert_eq!(record.port_id, "sample");

        let error = prepare_for_install(
            &library,
            "another-port",
            &root,
            &Uuid::new_v4().to_string(),
            0,
        )
        .unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Conflict);
        assert!(error.message.contains("owned by sample"));
    }

    #[test]
    fn external_root_rejects_overlap_and_unrelated_content_without_mutation() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let unrelated = temporary.path().join("unrelated");
        fs::create_dir(&unrelated).unwrap();
        fs::write(unrelated.join("keep.txt"), b"keep").unwrap();

        let error = prepare_for_install(
            &library,
            "sample",
            &unrelated,
            &Uuid::new_v4().to_string(),
            0,
        )
        .unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Conflict);
        assert_eq!(fs::read(unrelated.join("keep.txt")).unwrap(), b"keep");
        assert!(!unrelated.join(MARKER_NAME).exists());

        let protected = library.user_dir("sample");
        let error = prepare_for_install(
            &library,
            "sample",
            &protected,
            &Uuid::new_v4().to_string(),
            0,
        )
        .unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Conflict);
        assert!(!protected.exists());
    }

    #[test]
    fn external_root_rejects_registered_source_and_nested_output_overlap() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let source_directory = temporary.path().join("original-source");
        fs::create_dir(&source_directory).unwrap();
        let source = source_directory.join("original.rom");
        fs::write(&source, b"original").unwrap();
        library
            .register_source(&crate::SourceRecord {
                profile_id: "sample-source".into(),
                path: source.clone(),
                sha256: "0".repeat(64),
                size: 8,
                storage_sha256: "0".repeat(64),
                storage_size: 8,
                updated_at: 0,
            })
            .unwrap();
        let error = prepare_for_install(
            &library,
            "sample",
            &source_directory,
            &Uuid::new_v4().to_string(),
            0,
        )
        .unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Conflict);

        let first = temporary.path().join("first-output");
        prepare_for_install(&library, "sample", &first, &Uuid::new_v4().to_string(), 0).unwrap();
        let nested = first.join("nested");
        let error = prepare_for_install(
            &library,
            "another-port",
            &nested,
            &Uuid::new_v4().to_string(),
            0,
        )
        .unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Conflict);
        assert!(!nested.exists());
    }

    #[test]
    fn marker_tampering_blocks_reuse() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let root = temporary.path().join("game-output");
        prepare_for_install(&library, "sample", &root, &Uuid::new_v4().to_string(), 0).unwrap();
        fs::write(root.join(MARKER_NAME), b"{}").unwrap();

        let error = prepare_for_install(&library, "sample", &root, &Uuid::new_v4().to_string(), 0)
            .unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Verification);
    }

    #[test]
    fn authoritative_record_recovers_an_interrupted_marker_publication() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let root = temporary.path().join("game-output");
        fs::create_dir(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let record = OutputRootRecord {
            path: root.clone(),
            port_id: "sample".into(),
            marker_id: Uuid::new_v4().to_string(),
            volume_identity: volume_identity(&root).unwrap(),
        };
        library.register_output_root(&record).unwrap();

        prepare_for_install(&library, "sample", &root, &Uuid::new_v4().to_string(), 0).unwrap();

        assert!(root.join(MARKER_NAME).is_file());
    }

    #[test]
    fn insufficient_capacity_fails_before_claim_or_staging() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let root = temporary.path().join("game-output");

        let error = prepare_for_install(
            &library,
            "sample",
            &root,
            &Uuid::new_v4().to_string(),
            u64::MAX,
        )
        .unwrap_err();

        assert_eq!(error.code, crate::ErrorCode::Install);
        assert!(error.message.contains("enough available space"));
        assert!(!root.exists());
        assert!(library.output_roots().unwrap().is_empty());
    }

    #[test]
    fn recovery_rejects_private_staging_replaced_by_a_file() {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let operation_id = Uuid::new_v4().to_string();
        let staging = library.staging_dir().join(&operation_id);
        fs::write(&staging, b"not a directory").unwrap();

        let error = validate_staging_path(&library, "sample", &operation_id, &staging).unwrap_err();

        assert_eq!(error.code, crate::ErrorCode::Conflict);
        assert!(staging.is_file());
    }
}
