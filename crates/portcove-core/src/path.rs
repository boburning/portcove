use std::path::Path;

use crate::{PortcoveError, Result};

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
