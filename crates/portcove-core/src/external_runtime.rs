//! Read-only identity checks for a player-owned runtime. No path in this module
//! grants Portcove permission to copy, replace, clean up, or back up that tree.

use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{PortcoveError, Result, UserPreparedRuntimeSpec};

const MAX_FILES: usize = 100_000;
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const MAX_TREE_BYTES: u64 = 16 * 1024 * 1024 * 1024;

#[derive(Debug, Clone)]
pub(crate) struct InspectedExternalRuntime {
    pub root: PathBuf,
    pub executable: PathBuf,
    pub immutable_tree_sha256: String,
    pub immutable_file_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ExternalRuntimePreview {
    pub port_id: String,
    pub path: PathBuf,
    pub executable: PathBuf,
    pub version: String,
    pub archive_sha256: String,
    pub immutable_tree_sha256: String,
    pub immutable_file_count: usize,
    pub preview_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ExternalRuntimeRemovalPreview {
    pub port_id: String,
    pub path: PathBuf,
    pub version: String,
    pub external_files_will_be_preserved: bool,
    pub preview_sha256: String,
}

/// Hash every immutable regular file under one canonical root. Mutable paths
/// are explicit exceptions for game-owned output, not Portcove-owned content.
/// The signed definition supplies the expected digest; a first local scan
/// never blesses itself as authority.
#[cfg(test)]
pub(crate) fn inspect(
    requested_root: &Path,
    spec: &UserPreparedRuntimeSpec,
    library_root: &Path,
) -> Result<InspectedExternalRuntime> {
    inspect_with_checkpoint(requested_root, spec, library_root, &|| Ok(()))
}

pub(crate) fn inspect_with_checkpoint(
    requested_root: &Path,
    spec: &UserPreparedRuntimeSpec,
    library_root: &Path,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<InspectedExternalRuntime> {
    checkpoint()?;
    crate::path::refuse_symlink_ancestors(requested_root)?;
    let root = fs::canonicalize(requested_root)?;
    if !fs::symlink_metadata(&root)?.is_dir() {
        return Err(PortcoveError::usage(
            "user-prepared runtime must be a directory",
        ));
    }
    let library = fs::canonicalize(library_root)?;
    if root.starts_with(&library) || library.starts_with(&root) {
        return Err(PortcoveError::conflict(
            "user-prepared runtime must be outside the Portcove library",
        ));
    }
    let mut files = BTreeMap::<String, (PathBuf, u64, String)>::new();
    let mut seen = 0_usize;
    let mut total_bytes = 0_u64;
    visit(
        &root,
        &root,
        spec,
        &mut files,
        &mut seen,
        &mut total_bytes,
        checkpoint,
    )?;
    let (_, executable_key) = crate::archive::validate_relative_path(&spec.executable, false)?;
    let executable = files
        .get(&executable_key)
        .map(|(path, _, _)| path.clone())
        .ok_or_else(|| PortcoveError::verification("user-prepared executable is missing"))?;
    let mut digest = Sha256::new();
    digest.update(b"portcove-external-tree-v1\n");
    for (relative, (_, size, file_sha256)) in &files {
        digest.update(relative.as_bytes());
        digest.update([0]);
        digest.update(size.to_be_bytes());
        digest.update(
            hex::decode(file_sha256)
                .map_err(|_| PortcoveError::state("external runtime file digest was invalid"))?,
        );
    }
    let immutable_tree_sha256 = hex::encode(digest.finalize());
    if !immutable_tree_sha256.eq_ignore_ascii_case(&spec.immutable_tree_sha256) {
        return Err(PortcoveError::verification(
            "user-prepared runtime differs from the accepted immutable package",
        )
        .detail("expected_tree_sha256", &spec.immutable_tree_sha256)
        .detail("actual_tree_sha256", immutable_tree_sha256));
    }
    Ok(InspectedExternalRuntime {
        root,
        executable,
        immutable_tree_sha256,
        immutable_file_count: files.len(),
    })
}

fn visit(
    root: &Path,
    directory: &Path,
    spec: &UserPreparedRuntimeSpec,
    files: &mut BTreeMap<String, (PathBuf, u64, String)>,
    seen: &mut usize,
    total_bytes: &mut u64,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<()> {
    for entry in fs::read_dir(directory)? {
        checkpoint()?;
        let entry = entry?;
        *seen += 1;
        if *seen > MAX_FILES {
            return Err(PortcoveError::verification(
                "user-prepared runtime has too many entries",
            ));
        }
        let path = entry.path();
        let resolved = fs::canonicalize(&path)?;
        if !resolved.starts_with(root) || entry.file_type()?.is_symlink() {
            return Err(PortcoveError::verification(
                "user-prepared runtime contains a redirected path",
            ));
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|_| PortcoveError::state("external runtime path escaped its root"))?;
        let relative = crate::path::unicode(relative, "user-prepared runtime")?.replace('\\', "/");
        let kind = entry.file_type()?;
        let (_, key) = crate::archive::validate_relative_path(&relative, kind.is_dir())?;
        if kind.is_dir() {
            visit(root, &path, spec, files, seen, total_bytes, checkpoint)?;
            continue;
        }
        if !kind.is_file() {
            return Err(PortcoveError::verification(
                "user-prepared runtime contains a non-regular entry",
            ));
        }
        if spec.mutable_paths.iter().any(|mutable| {
            let mutable = mutable.to_ascii_lowercase();
            key == mutable || key.starts_with(&format!("{mutable}/"))
        }) {
            continue;
        }
        let size = entry.metadata()?.len();
        if size > MAX_FILE_BYTES || size > MAX_TREE_BYTES.saturating_sub(*total_bytes) {
            return Err(PortcoveError::verification(
                "user-prepared runtime exceeds the file or tree size limit",
            ));
        }
        *total_bytes += size;
        let file_sha256 = hash_bounded(&path, size, checkpoint)?;
        if files.insert(key, (path, size, file_sha256)).is_some() {
            return Err(PortcoveError::verification(
                "user-prepared runtime contains case-colliding files",
            ));
        }
    }
    Ok(())
}

fn hash_bounded(
    path: &Path,
    expected_size: u64,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<String> {
    let mut reader = fs::File::open(path)?;
    let mut digest = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        checkpoint()?;
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        total += read as u64;
        if total > expected_size || total > MAX_FILE_BYTES {
            return Err(PortcoveError::verification(
                "user-prepared runtime file changed or grew during inspection",
            ));
        }
        digest.update(&buffer[..read]);
    }
    if total != expected_size {
        return Err(PortcoveError::verification(
            "user-prepared runtime file changed during inspection",
        ));
    }
    Ok(hex::encode(digest.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf, UserPreparedRuntimeSpec) {
        let temporary = tempfile::tempdir().unwrap();
        let library = temporary.path().join("library");
        let runtime = temporary.path().join("player-runtime");
        fs::create_dir(&library).unwrap();
        fs::create_dir(&runtime).unwrap();
        fs::write(runtime.join("game.exe"), b"accepted executable").unwrap();
        let mut spec = UserPreparedRuntimeSpec {
            version: "1.0".into(),
            archive_name: "game-windows.zip".into(),
            archive_size: 100,
            archive_sha256: "a".repeat(64),
            executable: "game.exe".into(),
            immutable_tree_sha256: "0".repeat(64),
            source_argument_extension: None,
            mutable_paths: vec!["runtime-state".into()],
        };
        let mismatch = inspect(&runtime, &spec, &library).unwrap_err();
        spec.immutable_tree_sha256 = mismatch.details["actual_tree_sha256"].clone();
        (temporary, library, runtime, spec)
    }

    #[test]
    fn accepted_external_runtime_rechecks_immutable_bytes_and_ignores_only_declared_output() {
        let (_temporary, library, runtime, spec) = fixture();
        let first = inspect(&runtime, &spec, &library).unwrap();
        assert_eq!(first.immutable_file_count, 1);
        fs::create_dir(runtime.join("runtime-state")).unwrap();
        fs::write(
            runtime.join("runtime-state").join("save.dat"),
            b"player data",
        )
        .unwrap();
        inspect(&runtime, &spec, &library).unwrap();
        fs::write(runtime.join("game.exe"), b"changed executable").unwrap();
        assert!(inspect(&runtime, &spec, &library).is_err());
        assert_eq!(
            fs::read(runtime.join("runtime-state").join("save.dat")).unwrap(),
            b"player data"
        );
    }

    #[test]
    fn unknown_extra_content_and_library_overlap_refuse_without_mutation() {
        let (_temporary, library, runtime, spec) = fixture();
        fs::write(runtime.join("other.dll"), b"foreign loader").unwrap();
        assert!(inspect(&runtime, &spec, &library).is_err());
        assert_eq!(
            fs::read(runtime.join("other.dll")).unwrap(),
            b"foreign loader"
        );
        assert!(inspect(&library, &spec, &library).is_err());
    }
}
