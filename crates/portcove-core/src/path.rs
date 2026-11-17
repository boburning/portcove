use std::path::Path;

use crate::{PortcoveError, Result};

#[cfg(test)]
#[path = "path_property_tests.rs"]
mod property_tests;

/// Normalizes a Win32 path for a case-insensitive containment comparison:
/// verbatim prefixes are removed, separators unified and trailing separators
/// dropped. It never touches the filesystem.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn comparable_windows_path(path: &str) -> String {
    let path = path.replace('/', "\\");
    // `\\?\` verbatim prefix; `\\?\UNC\server\share` becomes `\\server\share`.
    let path = match path.strip_prefix("\\\\?\\") {
        Some(verbatim) => match verbatim.strip_prefix("UNC\\") {
            Some(unc) => format!("\\\\{unc}"),
            None => verbatim.to_owned(),
        },
        None => path,
    };
    path.trim_end_matches('\\').to_lowercase()
}

pub(crate) fn is_portcove_metadata(path: &Path) -> bool {
    path.to_str().is_some_and(|relative| {
        relative.split(['/', '\\']).any(|name| {
            let name = name.to_ascii_lowercase();
            name.starts_with(".portcove-") || name.ends_with(".portcove-source.json")
        })
    })
}

pub(crate) fn refuse_symlink_ancestors(path: &Path) -> Result<()> {
    for candidate in path.ancestors() {
        match std::fs::symlink_metadata(candidate) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(PortcoveError::conflict(format!(
                    "refusing to synchronize through a symlink: {}",
                    candidate.display()
                )));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

/// Bound the read itself as well as the initial stat, including concurrent file growth.
pub(crate) fn read_bounded_regular(path: &Path, limit: u64) -> Result<Vec<u8>> {
    use std::io::Read;
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(
            PortcoveError::verification("metadata must be a bounded regular file")
                .detail("path", path.display().to_string()),
        );
    }
    if metadata.len() > limit {
        return Err(
            PortcoveError::verification("metadata must be a bounded regular file")
                .detail("path", path.display().to_string())
                .detail("bounded_regular_oversize", "true"),
        );
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)?
        .take(limit.saturating_add(1))
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(
            PortcoveError::verification("metadata grew beyond its read limit")
                .detail("bounded_regular_oversize", "true"),
        );
    }
    Ok(bytes)
}

/// Resolve aliases in the existing part while preserving missing descendants.
/// Missing install directories must remain exportable as recovery metadata.
pub(crate) fn resolve_existing_ancestor(path: &Path) -> Result<std::path::PathBuf> {
    let mut existing = std::path::absolute(path)?;
    let mut tail = Vec::new();
    loop {
        match std::fs::symlink_metadata(&existing) {
            Ok(_) => break,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let name = existing
                    .file_name()
                    .ok_or_else(|| PortcoveError::usage("path has no resolvable parent"))?
                    .to_owned();
                tail.push(name);
                if !existing.pop() {
                    return Err(PortcoveError::usage("path has no resolvable parent"));
                }
            }
            Err(error) => return Err(error.into()),
        }
    }
    let mut resolved = std::fs::canonicalize(existing)?;
    for name in tail.into_iter().rev() {
        resolved.push(name);
    }
    Ok(resolved)
}

pub(crate) fn existing_ancestor(path: &Path) -> Result<std::path::PathBuf> {
    let mut existing = std::path::absolute(path)?;
    loop {
        match std::fs::symlink_metadata(&existing) {
            Ok(_) => return std::fs::canonicalize(existing).map_err(Into::into),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if !existing.pop() {
                    return Err(PortcoveError::usage("path has no existing parent"));
                }
            }
            Err(error) => return Err(error.into()),
        }
    }
}

pub(crate) fn normalized_absolute(path: &Path, role: &str) -> Result<std::path::PathBuf> {
    if path.as_os_str().is_empty() {
        return Err(PortcoveError::usage(format!("{role} cannot be empty")));
    }
    unicode(path, role)?;
    let resolved = resolve_existing_ancestor(&std::path::absolute(path)?)?;
    unicode(&resolved, role)?;
    Ok(resolved)
}

/// Compare saved Win32 disk and UNC spellings even when their volume is offline
/// or the reader runs on another OS. Only the volume prefix and separators change.
pub(crate) fn comparable_windows_absolute(path: &Path) -> Option<String> {
    let separators = path.to_str()?.replace('\\', "/");
    let mut ordinary = match separators.strip_prefix("//?/") {
        Some(verbatim) => match verbatim.strip_prefix("UNC/") {
            Some(unc) => format!("//{unc}"),
            None => verbatim.to_owned(),
        },
        None => separators,
    };
    if matches!(ordinary.as_bytes(), [drive, b':', b'/', ..] if drive.is_ascii_alphabetic()) {
        ordinary.get_mut(..1)?.make_ascii_uppercase();
        return Some(ordinary);
    }
    let mut unc = ordinary.strip_prefix("//")?.split('/');
    let (host, share) = (unc.next()?, unc.next()?);
    (![host, share]
        .iter()
        .any(|name| matches!(*name, "" | "." | ".." | "?")))
    .then_some(ordinary)
}

/// V1's durable and child-process contracts use Unicode strings on every host.
/// Reject an unrepresentable path at the boundary instead of storing or passing
/// a lossy alias that cannot identify the original filesystem object.
pub(crate) fn unicode(path: &Path, role: &str) -> Result<String> {
    path.to_str().map(str::to_owned).ok_or_else(|| {
        PortcoveError::unsupported(format!(
            "Portcove V1 requires {role} paths to be valid Unicode"
        ))
        .with_known_cause(crate::failure::KnownFailureCause::UnicodePath)
        .detail("path_role", role)
    })
}

#[cfg(test)]
#[test]
fn ancestor_check_allows_missing_components() {
    let temporary = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(temporary.path()).unwrap();
    refuse_symlink_ancestors(&root.join("missing/child")).unwrap();
}

#[cfg(all(test, unix))]
#[test]
fn ancestor_check_propagates_metadata_errors() {
    let temporary = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(temporary.path()).unwrap();
    let file = root.join("file");
    std::fs::write(&file, b"").unwrap();
    let child = file.join("child");
    let metadata_error = std::fs::symlink_metadata(&child).unwrap_err();
    assert_eq!(metadata_error.kind(), std::io::ErrorKind::NotADirectory);
    assert_eq!(
        refuse_symlink_ancestors(&child).unwrap_err().message,
        metadata_error.to_string()
    );
}

#[cfg(all(test, unix))]
mod tests {
    use std::{ffi::OsString, os::unix::ffi::OsStringExt, path::PathBuf};

    #[test]
    fn non_unicode_paths_are_explicitly_unsupported() {
        let path = PathBuf::from(OsString::from_vec(vec![b'p', 0xff]));

        let error = super::unicode(&path, "test source").unwrap_err();

        assert_eq!(error.code, crate::ErrorCode::Unsupported);
        assert_eq!(error.details["path_role"], "test source");
    }
}
