//! Exact pinned RmlUi compiler-frontend diagnostic correction.
use super::super::digest;
use crate::{PortcoveError, Result};
use std::path::Path;

pub(super) const BEFORE: &str = "07405dda6294dec00fe4aa4deac10250dbfe5355918ada3707e005aa359aad3d";
pub(super) const AFTER: &str = "0085b1b2c0a284ddcf4784474591846760c648265ecc0e62a4b373c04647ee41";
const SITE: &str = "\tif(RMLUI_COMPILER_OPTIONS)\n\t\tif(CMAKE_CXX_COMPILER_ID MATCHES \"Clang\" OR CMAKE_CXX_COMPILER_ID MATCHES \"GNU\")\n\t\t\ttarget_compile_options(${target} PRIVATE -Wall -Wextra -pedantic)\n";
const REPLACEMENT: &str = "\tif(RMLUI_COMPILER_OPTIONS)\n\t\tif(CMAKE_CXX_COMPILER_ID MATCHES \"Clang\" AND CMAKE_CXX_COMPILER_FRONTEND_VARIANT STREQUAL \"MSVC\")\n\t\t\ttarget_compile_options(${target} PRIVATE /clang:-Wall /clang:-Wextra /clang:-pedantic)\n\t\telseif(CMAKE_CXX_COMPILER_ID MATCHES \"Clang\" OR CMAKE_CXX_COMPILER_ID MATCHES \"GNU\")\n\t\t\ttarget_compile_options(${target} PRIVATE -Wall -Wextra -pedantic)\n";

pub(super) fn apply(project: &Path) -> Result<()> {
    let path = project.join("lib/RmlUi/CMake/Utilities.cmake");
    let bytes = crate::path::read_bounded_regular(&path, 16 * 1024)?;
    if digest(&bytes) != BEFORE {
        return Err(PortcoveError::verification(
            "CVLoD RmlUi compiler options preimage differs",
        ));
    }
    let text = String::from_utf8(bytes)
        .map_err(|_| PortcoveError::verification("CVLoD RmlUi compiler options are not UTF-8"))?;
    if text.matches(SITE).count() != 1 {
        return Err(PortcoveError::verification(
            "CVLoD RmlUi compiler options site is not unique",
        ));
    }
    // clang-cl interprets bare -Wall as -Weverything and ignores -pedantic.
    // Forward the intended GNU diagnostic flags without changing their groups.
    let patched = text.replace(SITE, REPLACEMENT);
    if digest(patched.as_bytes()) != AFTER {
        return Err(PortcoveError::verification(
            "CVLoD RmlUi compiler options result differs",
        ));
    }
    std::fs::write(path, patched)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    const ORIGINAL: &[u8] = include_bytes!("fixtures/rmlui-utilities.cmake");

    #[test]
    fn cvlod_rmlui_diagnostics_patch_requires_exact_source_and_result() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("lib/RmlUi/CMake/Utilities.cmake");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        assert_eq!(digest(ORIGINAL), BEFORE);
        std::fs::write(&path, ORIGINAL).unwrap();
        apply(temporary.path()).unwrap();
        let patched = std::fs::read(&path).unwrap();
        assert_eq!(digest(&patched), AFTER);
        assert_eq!(
            String::from_utf8(patched.clone())
                .unwrap()
                .replace(REPLACEMENT, SITE)
                .as_bytes(),
            ORIGINAL
        );
        // Reapplication cannot silently accept another input identity.
        assert!(apply(temporary.path()).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), patched);
    }

    #[test]
    fn cvlod_rmlui_diagnostics_patch_refuses_changed_or_oversized_source_before_write() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("lib/RmlUi/CMake/Utilities.cmake");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        for bytes in [
            [ORIGINAL, b"\n"].concat(),
            String::from_utf8(ORIGINAL.to_vec())
                .unwrap()
                .replace("-Wall", "-Wno-everything")
                .into_bytes(),
            vec![b'x'; 16 * 1024 + 1],
        ] {
            std::fs::write(&path, &bytes).unwrap();
            assert!(apply(temporary.path()).is_err());
            assert_eq!(std::fs::read(&path).unwrap(), bytes);
        }
    }
}
