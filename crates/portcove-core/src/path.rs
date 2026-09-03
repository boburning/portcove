use std::path::Path;

use crate::{PortcoveError, Result};

pub(crate) fn refuse_symlink_ancestors(path: &Path) -> Result<()> {
    for candidate in path.ancestors() {
        if std::fs::symlink_metadata(candidate)
            .is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            return Err(PortcoveError::conflict(format!(
                "refusing to synchronize through a symlink: {}",
                candidate.display()
            )));
        }
    }
    Ok(())
}

/// Bound the read itself as well as the initial stat, including concurrent file growth.
pub(crate) fn read_bounded_regular(path: &Path, limit: u64) -> Result<Vec<u8>> {
    use std::io::Read;
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > limit {
        return Err(
            PortcoveError::verification("metadata must be a bounded regular file")
                .detail("path", path.display().to_string()),
        );
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)?
        .take(limit.saturating_add(1))
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(PortcoveError::verification(
            "metadata grew beyond its read limit",
        ));
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

/// V1's durable and child-process contracts use Unicode strings on every host.
/// Reject an unrepresentable path at the boundary instead of storing or passing
/// a lossy alias that cannot identify the original filesystem object.
pub(crate) fn unicode(path: &Path, role: &str) -> Result<String> {
    path.to_str().map(str::to_owned).ok_or_else(|| {
        PortcoveError::unsupported(format!(
            "Portcove V1 requires {role} paths to be valid Unicode"
        ))
        .detail("path_role", role)
    })
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
