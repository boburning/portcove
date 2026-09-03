use std::path::Path;

use crate::{PortcoveError, Result};

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
