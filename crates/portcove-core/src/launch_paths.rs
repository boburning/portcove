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

/// Whether free text that catalog data passes to a launched process (an
/// argument or an environment value) stays inside the closed path set: a path
/// may come only from [`LaunchPath`], never from text.
///
/// The text is refused when it has a control character or expansion syntax
/// (`%`, `$` or a backtick anywhere, which covers `%NAME%`, `$NAME`,
/// `${NAME}` and `$(...)`). Otherwise it is split into elements on `;`, `,`,
/// `=` and ASCII whitespace; each element is refused when it starts with an
/// ASCII letter and `:` (a drive-absolute or drive-relative path such as
/// `C:\x` or `C:x`) or with a case-insensitive `file:` scheme. The element is
/// then split into segments on `:` (a path-list separator; a single
/// `key:value` token such as `profile:fast` keeps two harmless segments), and
/// a segment is refused when it starts with `/` or `\` (root-relative, UNC,
/// device and extended `\\?\` paths, and `scheme://` locations), starts with
/// `~`, or has a component in either separator style that is a parent
/// reference (only dots and spaces with at least two dots, which Windows
/// normalizes to `..`) or a reserved DOS device name.
pub(crate) fn is_contained_launch_text(text: &str) -> bool {
    if text
        .chars()
        .any(|character| character.is_control() || matches!(character, '%' | '$' | '`'))
    {
        return false;
    }
    text.split(|character: char| {
        matches!(character, ';' | ',' | '=') || character.is_ascii_whitespace()
    })
    .filter(|element| !element.is_empty())
    .all(|element| {
        let bytes = element.as_bytes();
        !(bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
            && !bytes
                .get(..5)
                .is_some_and(|scheme| scheme.eq_ignore_ascii_case(b"file:"))
            && element.split(':').all(|segment| {
                !segment.starts_with(['/', '\\', '~'])
                    && segment.split(['/', '\\']).all(contained_component)
            })
    })
}

fn contained_component(component: &str) -> bool {
    let parent = component
        .chars()
        .all(|character| matches!(character, '.' | ' '))
        && component.matches('.').count() >= 2;
    let stem = component
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end_matches(' ')
        .to_ascii_uppercase();
    let device = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0');
    !parent && !device
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
