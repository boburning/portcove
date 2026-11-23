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

/// Whether legacy free text that catalog data passes to a launched process (a
/// `launch_environment` value or a `launch_arguments` or `setup_arguments`
/// entry) stays inside the installation. Existing catalog data may carry
/// relative paths here; a reviewed launch contract uses the stricter
/// [`is_contract_launch_text`] instead.
///
/// The text is refused when it has a non-ASCII or control character, a quote
/// (`"` or `'`), expansion syntax (`%`, `$` or a backtick anywhere, which
/// covers `%NAME%`, `$NAME`, `${NAME}` and `$(...)`), or `\\` or `//` anywhere
/// (UNC, device, extended and `scheme://` locations). Otherwise it is split
/// into elements on `;`, `,`, `=` and ASCII whitespace; each element is
/// refused when it starts with `@` (a response file), starts with an ASCII
/// letter and `:` (a drive-absolute or drive-relative path such as `C:\x` or
/// `C:x`), has a drive form after an option sigil (`-C:x`, `--C:x`, or the
/// attached short option `-dC:x`), or starts with a case-insensitive `file:`
/// scheme. The element is then split into segments on `:` (a path-list
/// separator; a single `key:value` token such as `profile:fast` keeps two
/// harmless segments), and a segment is refused when it starts with `/` or
/// `\` (root-relative), starts with `~`, or has a component in either
/// separator style that is a parent reference (only dots and spaces with at
/// least two dots, which Windows normalizes to `..`), ends in `..`, is a
/// reserved DOS device name, or starts with `-` or `+` and is followed by a
/// separator (an option with an attached path, such as `-I/etc`).
pub(crate) fn is_contained_launch_text(text: &str) -> bool {
    if !text.is_ascii()
        || text.chars().any(|character| {
            character.is_ascii_control() || matches!(character, '%' | '$' | '`' | '"' | '\'')
        })
        || text.contains("\\\\")
        || text.contains("//")
    {
        return false;
    }
    text.split(|character: char| {
        matches!(character, ';' | ',' | '=') || character.is_ascii_whitespace()
    })
    .filter(|element| !element.is_empty())
    .all(|element| {
        let bytes = element.as_bytes();
        let drive =
            |bytes: &[u8]| bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
        let body = element.trim_start_matches(['-', '+']).as_bytes();
        let single_sigil = element.len() - body.len() == 1;
        !element.starts_with('@')
            && !drive(bytes)
            && !drive(body)
            && !(single_sigil && body.len() >= 3 && drive(&body[1..]))
            && !bytes
                .get(..5)
                .is_some_and(|scheme| scheme.eq_ignore_ascii_case(b"file:"))
            && element.split(':').all(|segment| {
                let mut components = segment.split(['/', '\\']).peekable();
                !segment.starts_with(['/', '\\', '~'])
                    && std::iter::from_fn(|| {
                        let component = components.next()?;
                        Some((component, components.peek().is_some()))
                    })
                    .all(|(component, followed)| {
                        contained_component(component)
                            && !(followed && component.starts_with(['-', '+']))
                    })
            })
    })
}

/// The bound on one literal reviewed launch contract value.
pub(crate) const MAX_CONTRACT_TEXT_LEN: usize = 256;

/// Whether a literal text value of a reviewed launch contract (an environment
/// value or a text argument) is accepted. A location may only come from the
/// closed [`LaunchPath`] set, so the accepted text has no path character by
/// construction:
///
/// - It is 1 to [`MAX_CONTRACT_TEXT_LEN`] bytes drawn only from ASCII letters,
///   digits and `.` `_` `=` `,` `+` `-` `:`. Everything else is refused,
///   including `/`, `\`, quotes, `@`, `%`, `$`, backtick, `~`, `;`,
///   whitespace, control characters and every non-ASCII character.
/// - It has no `..` anywhere.
/// - It is split into tokens at `=` and `,`. A token may start with one option
///   sigil, `-`, `--` or `+`, whose remaining body must not start with `-` or
///   `+` again. A token with a sigil has no `:`. In a token without a sigil,
///   every `:`-separated segment before the last has at least two characters
///   and no `.`, which refuses drive forms (`C:x`) and alternate data streams
///   (`a.txt:evil`) while keeping `profile:fast`.
/// - No `:`-separated segment of a token's body, nor the body after its first
///   character for a single `-` or `+` sigil (an attached short option such as
///   `-oNUL`), is a reserved Windows device name with or without an extension.
/// - No token names an option in [`REFUSED_CONTRACT_OPTIONS`] or an option
///   ending in `-cmd-prefix` or `-launcher` (case-insensitive, any sigil).
pub(crate) fn is_contract_launch_text(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= MAX_CONTRACT_TEXT_LEN
        && text.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(byte, b'.' | b'_' | b'=' | b',' | b'+' | b'-' | b':')
        })
        && !text.contains("..")
        && text.split(['=', ',']).all(contract_token)
}

/// Option names that make a launched runtime load code, open a debugger or
/// delegate process creation even when every character is in the strict
/// contract class. Compared case-insensitively after any `-`, `--` or `+`
/// sigil and before any `=`; names ending in `-cmd-prefix` or `-launcher` are
/// refused as well. This list does not bound every runtime's semantic flags:
/// review of a contract's literal arguments remains a publication-time
/// responsibility.
pub(crate) const REFUSED_CONTRACT_OPTIONS: &[&str] = &[
    "remote-debugging-port",
    "remote-debugging-pipe",
    "remote-debugging-address",
    "remote-allow-origins",
    "inspect",
    "inspect-brk",
    "inspect-port",
    "inspect-wait",
    "debug-port",
    "load-extension",
    "disable-extensions-except",
    "browser-subprocess-path",
    "js-flags",
    "require",
    "import",
    "loader",
    "experimental-loader",
    "no-sandbox",
    "disable-web-security",
    "register-pepper-plugins",
];

fn contract_token(token: &str) -> bool {
    let sigil = if token.starts_with("--") {
        2
    } else if token.starts_with(['-', '+']) {
        1
    } else {
        0
    };
    let body = &token[sigil..];
    if body.starts_with(['-', '+']) {
        return false;
    }
    if sigil > 0 {
        let name = body.to_ascii_lowercase();
        return !body.contains(':')
            && contained_component(body)
            && !(sigil == 1 && body.len() > 1 && !contained_component(&body[1..]))
            && !REFUSED_CONTRACT_OPTIONS.contains(&name.as_str())
            && !name.ends_with("-cmd-prefix")
            && !name.ends_with("-launcher");
    }
    let segments = body.split(':').collect::<Vec<_>>();
    segments.iter().all(|segment| contained_component(segment))
        && segments[..segments.len() - 1]
            .iter()
            .all(|segment| segment.len() >= 2 && !segment.contains('.'))
}

/// A path component that is neither a parent reference (only dots and spaces
/// with at least two dots, or any component ending in `..`) nor a reserved DOS
/// device name. Device names are recognized case-insensitively with or
/// without an extension and trailing spaces, including `COM` and `LPT` with a
/// superscript digit, which Windows also treats as devices.
fn contained_component(component: &str) -> bool {
    let parent = (component
        .chars()
        .all(|character| matches!(character, '.' | ' '))
        && component.matches('.').count() >= 2)
        || component.ends_with("..");
    let stem = component
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end_matches(' ')
        .to_uppercase();
    let numbered = stem
        .strip_prefix("COM")
        .or_else(|| stem.strip_prefix("LPT"))
        .is_some_and(|digit| {
            matches!(
                digit,
                "1" | "2"
                    | "3"
                    | "4"
                    | "5"
                    | "6"
                    | "7"
                    | "8"
                    | "9"
                    | "\u{b9}"
                    | "\u{b2}"
                    | "\u{b3}"
            )
        });
    let device = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL") || numbered;
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
