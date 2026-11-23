//! Closed launch path expansion. Values come from the resolved launch request.
use std::path::Path;

use crate::{PortcoveError, Result};

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, schemars::JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum LaunchPath {
    InstallRoot,
    UserData,
    Source,
    Cache,
}

pub(crate) struct LaunchPaths<'a> {
    install_root: &'a Path,
    user_data: &'a Path,
    source: Option<&'a Path>,
}

impl<'a> LaunchPaths<'a> {
    pub(crate) fn new(
        install_root: &'a Path,
        user_data: &'a Path,
        source: Option<&'a Path>,
    ) -> Self {
        Self {
            install_root,
            user_data,
            source,
        }
    }

    pub(crate) fn expand(&self, path: LaunchPath) -> Result<String> {
        match path {
            LaunchPath::InstallRoot => crate::path::unicode(self.install_root, "installation root"),
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
        let root = Path::new("installed game");
        let data = Path::new("data with spaces");
        let source = Path::new("approved originals/disc.bin");
        let targets = LaunchPaths::new(root, data, Some(source));
        for (path, expected) in [
            (LaunchPath::InstallRoot, root.to_path_buf()),
            (LaunchPath::UserData, data.to_path_buf()),
            (LaunchPath::Source, source.to_path_buf()),
            (LaunchPath::Cache, data.join("cache")),
        ] {
            assert_eq!(targets.expand(path).unwrap(), expected.to_str().unwrap());
        }
        assert!(
            LaunchPaths::new(root, data, None)
                .expand(LaunchPath::Source)
                .is_err()
        );
    }
}
