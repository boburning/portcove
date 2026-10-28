//! Safe relative names for already-generated filesystem trees.
//!
//! Downloaded archive members intentionally use the stricter ASCII-only policy
//! in `archive`. Upstream setup output can contain source-derived Unicode names;
//! this policy preserves those names while rejecting traversal and aliases under
//! NFD full case folding with default-ignorable code points removed.

use std::path::PathBuf;

use icu_casemap::CaseMapper;
use icu_properties::props::{BinaryProperty, DefaultIgnorableCodePoint};
use unicode_normalization::UnicodeNormalization;

use crate::{PortcoveError, Result};

const MAX_PATH_BYTES: usize = 1024;
const MAX_PATH_DEPTH: usize = 32;
const MAX_COMPONENT_UTF16_UNITS: usize = 255;

pub(crate) fn validate_relative_path(name: &str, directory: bool) -> Result<(PathBuf, String)> {
    if name.contains('\\') {
        return Err(PortcoveError::verification(
            "generated-tree paths must use forward-slash separators",
        ));
    }
    let canonical = if directory && name.ends_with('/') {
        &name[..name.len() - 1]
    } else {
        name
    };
    if canonical.is_empty() || canonical.len() > MAX_PATH_BYTES || canonical.ends_with('/') {
        return Err(PortcoveError::verification(
            "generated tree contains an empty or overlong path",
        ));
    }
    let components = canonical.split('/').collect::<Vec<_>>();
    if components.len() > MAX_PATH_DEPTH {
        return Err(PortcoveError::verification(
            "generated-tree path exceeds the maximum depth",
        ));
    }
    for component in &components {
        validate_component(component)?;
    }
    let key = components
        .iter()
        .map(|component| {
            let decomposed = component.nfd().collect::<String>();
            let folded = CaseMapper::new().fold_string(&decomposed);
            folded
                .chars()
                .filter(|character| !DefaultIgnorableCodePoint::for_char(*character))
                .nfd()
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("/");
    Ok((PathBuf::from(canonical), key))
}

fn validate_component(component: &str) -> Result<()> {
    if component.is_empty()
        || matches!(component, "." | "..")
        || component.encode_utf16().count() > MAX_COMPONENT_UTF16_UNITS
        || component.ends_with(['.', ' '])
        || component.chars().any(char::is_control)
        || component
            .chars()
            .any(|character| matches!(character, ':' | '"' | '<' | '>' | '|' | '?' | '*'))
    {
        return Err(PortcoveError::verification(format!(
            "generated tree contains an unsafe path component: {component}"
        )));
    }
    let stem = component
        .split_once('.')
        .map_or(component, |(stem, _)| stem)
        .trim_end_matches([' ', '.'])
        .to_uppercase();
    let device_number = stem
        .strip_prefix("COM")
        .or_else(|| stem.strip_prefix("LPT"));
    let reserved = matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || device_number.is_some_and(|suffix| {
        matches!(
            suffix,
            "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
        )
    });
    if reserved {
        return Err(PortcoveError::verification(format!(
            "generated tree contains a reserved device path: {component}"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_unicode_names_without_compatibility_normalization() {
        let original = "assets/dataDir/stages/コピー ～ practice/re_ｐ2_00.blo";
        let (path, key) = validate_relative_path(original, false).unwrap();
        assert_eq!(path.to_str(), Some(original));
        let (_, ascii_key) = validate_relative_path(
            "assets/dataDir/stages/コピー ～ practice/re_p2_00.blo",
            false,
        )
        .unwrap();
        assert_ne!(key, ascii_key);
    }

    #[test]
    fn collision_keys_use_full_canonical_casefold_without_compatibility_mapping() {
        let (_, composed) = validate_relative_path("Assets/Étage.bin", false).unwrap();
        let (_, decomposed) = validate_relative_path("assets/E\u{301}tage.BIN", false).unwrap();
        assert_eq!(composed, decomposed);

        let (_, sigma) = validate_relative_path("assets/σ.bin", false).unwrap();
        let (_, final_sigma) = validate_relative_path("assets/ς.bin", false).unwrap();
        assert_eq!(sigma, final_sigma);

        let (_, sharp_s) = validate_relative_path("assets/Straße.bin", false).unwrap();
        let (_, double_s) = validate_relative_path("assets/STRASSE.BIN", false).unwrap();
        assert_eq!(sharp_s, double_s);

        let (_, invisible) = validate_relative_path("assets/foo\u{200b}.bin", false).unwrap();
        let (_, visible) = validate_relative_path("assets/foo.bin", false).unwrap();
        assert_eq!(invisible, visible);
    }

    #[test]
    fn unicode_18_casefold_aliases_preserve_original_paths() {
        // Unicode 18 assigns A7DD and folds it to the existing U+0277.
        // Keys are collision checks; the filesystem spelling must stay intact.
        let upper = "assets/\u{a7dd}.bin";
        let lower = "assets/\u{0277}.bin";
        let (upper_path, upper_key) = validate_relative_path(upper, false).unwrap();
        let (lower_path, lower_key) = validate_relative_path(lower, false).unwrap();
        assert_eq!(upper_path.to_str(), Some(upper));
        assert_eq!(lower_path.to_str(), Some(lower));
        assert_eq!(upper_key, lower_key);
        assert_eq!(upper_key, lower);
    }

    #[test]
    fn collision_keys_reorder_unicode_18_combining_marks() {
        // Unicode 18 assigns U+1AEE combining class 220, before U+0301 (230).
        // Preserve the actual names while recognizing their canonical alias.
        let first = "assets/a\u{301}\u{1aee}.bin";
        let second = "assets/a\u{1aee}\u{301}.bin";
        let (first_path, first_key) = validate_relative_path(first, false).unwrap();
        let (second_path, second_key) = validate_relative_path(second, false).unwrap();
        assert_eq!(first_path.to_str(), Some(first));
        assert_eq!(second_path.to_str(), Some(second));
        assert_eq!(first_key, second_key);
        assert_eq!(first_key, second);
    }

    #[test]
    fn rejects_unsafe_and_windows_unrepresentable_generated_paths() {
        for path in [
            "../outside.bin",
            "assets/CON.txt",
            "assets/COM¹.bin",
            "assets/CONOUT$.log",
            "assets/invalid.",
            "assets/a:b.bin",
            "assets\\backslash.bin",
        ] {
            assert!(
                validate_relative_path(path, false).is_err(),
                "accepted {path:?}"
            );
        }
        assert!(
            validate_relative_path(&format!("assets/{}.bin", "😀".repeat(128)), false).is_err()
        );
        assert!(validate_relative_path(&format!("{}x", "a/".repeat(32)), false).is_err());
    }
}
