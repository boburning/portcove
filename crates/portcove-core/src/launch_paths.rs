//! Closed launch path expansion. Values come from the resolved launch request.
use std::path::Path;

use crate::{PortcoveError, Result};

#[derive(Clone, Copy)]
pub(crate) enum LaunchPath {
    UserData,
    Source,
    Cache,
}

pub(crate) struct LaunchPaths<'a> {
    user_data: &'a Path,
    source: Option<&'a Path>,
}

impl<'a> LaunchPaths<'a> {
    pub(crate) fn new(user_data: &'a Path, source: Option<&'a Path>) -> Self {
        Self { user_data, source }
    }

    pub(crate) fn expand(&self, path: LaunchPath) -> Result<String> {
        match path {
            LaunchPath::UserData => crate::path::unicode(self.user_data, "user data"),
            LaunchPath::Source => crate::path::unicode(
                self.source.ok_or_else(|| {
                    PortcoveError::launch("launch path requires a verified source")
                })?,
                "source",
            ),
            LaunchPath::Cache => crate::path::unicode(&self.user_data.join("cache"), "cache"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expansion_keeps_whole_paths_and_requires_the_actual_source() {
        let data = Path::new("data with spaces");
        let source = Path::new("approved originals/disc.bin");
        let targets = LaunchPaths::new(data, Some(source));
        for (path, expected) in [
            (LaunchPath::UserData, data.to_path_buf()),
            (LaunchPath::Source, source.to_path_buf()),
            (LaunchPath::Cache, data.join("cache")),
        ] {
            assert_eq!(targets.expand(path).unwrap(), expected.to_str().unwrap());
        }
        assert!(
            LaunchPaths::new(data, None)
                .expand(LaunchPath::Source)
                .is_err()
        );
    }
}
