//! Pinned offline Gundam source projection; no setup host or mod authority.
use super::{BuildArchive, BuildInputs, cmake_path, copy_verified, digest, write_new};
use crate::{PortcoveError, Result};
use std::path::{Path, PathBuf};

pub(super) const GAME: BuildArchive = BuildArchive {
    name: "GundamWingEndlessDuelSNESRecomp-c7aaaa152192db5d750db3fb190e8f93b6240c19.zip",
    url: "https://codeload.github.com/TechnicallyComputers/GundamWingEndlessDuelSNESRecomp/zip/c7aaaa152192db5d750db3fb190e8f93b6240c19",
    size: 3_363_589,
    sha256: "bfe295943d83d144def7f355ac47f04fd90fb5bd2000ca0217e7874dfc33c2ee",
    root: "GundamWingEndlessDuelSNESRecomp-c7aaaa152192db5d750db3fb190e8f93b6240c19",
};
pub(super) const ENGINE: BuildArchive = BuildArchive {
    name: "snesrecomp-f68aa0fe8edae75cbc7d4b9473c71687b45ce702.zip",
    url: "https://codeload.github.com/RetroPortingToolKit/snesrecomp/zip/f68aa0fe8edae75cbc7d4b9473c71687b45ce702",
    size: 6_052_919,
    sha256: "c30639794a0c713bfcbdf2abeb10576fe8c532201b481af02bd3eab42904026f",
    root: "snesrecomp-f68aa0fe8edae75cbc7d4b9473c71687b45ce702",
};
pub(super) const ANALYZER: BuildArchive = BuildArchive {
    name: "gundamwingendlessduel-0.1.11-windows-x64.zip",
    url: "https://github.com/TechnicallyComputers/GundamWingEndlessDuelSNESRecomp/releases/download/v0.1.11/gundamwingendlessduel-0.1.11-windows-x64.zip",
    size: 225_468_722,
    sha256: "03f470fb6585db9cba174548257b643430efba51fe0964b65ce108c50e50424a",
    root: "gundamwingendlessduel-0.1.11-windows-x64/snesrecomp/recompiler-rs/target/release",
};
pub(super) const UI: BuildArchive = BuildArchive {
    name: "recomp-ui-0546fbcb0126bb14bf88d2128b4fe8a4229570a3.zip",
    url: "https://codeload.github.com/RetroPortingToolKit/recomp-ui/zip/0546fbcb0126bb14bf88d2128b4fe8a4229570a3",
    size: 5_075_056,
    sha256: "829bf3f3863030a690f33084530024cec6411cc8c5ddfa6a514e89519ced3a68",
    root: "recomp-ui-0546fbcb0126bb14bf88d2128b4fe8a4229570a3",
};

pub(super) const ANALYZER_SHA256: &str =
    "bc1d908cfcf4199d5cb9001ba6be9d18059ef5291788705bf34fadfb3f4f2414";

pub(super) fn analyzer(inputs: &BuildInputs) -> Result<PathBuf> {
    let files = &inputs.identities[4];
    if files.len() != 1
        || files[0].path != "snesrecomp-analyze.exe"
        || files[0].size != 1_306_624
        || files[0].sha256 != ANALYZER_SHA256
    {
        return Err(PortcoveError::verification(
            "fixed Gundam analyzer directory differs from its package contract",
        ));
    }
    let path = inputs.roots[4].join("snesrecomp-analyze.exe");
    if crate::adapter::hash_file_bounded_with_checkpoint(&path, 1_306_624, || Ok(()))?
        != (ANALYZER_SHA256.into(), 1_306_624)
    {
        return Err(PortcoveError::verification("fixed Gundam analyzer changed"));
    }
    Ok(path)
}

pub(super) fn project(
    inputs: &BuildInputs,
    project: &Path,
    checkpoint: &dyn Fn() -> Result<()>,
) -> Result<()> {
    for name in [
        "recomp_frame_blend.h",
        "recomp_flash_guard.h",
        "common/recomp_frame_blend.c",
        "common/recomp_flash_guard.c",
    ] {
        copy_verified(
            &inputs.roots[5].join("src").join(name),
            &project.join("portcove-presentation").join(name),
            checkpoint,
        )?;
    }
    replace_pinned(
        &project.join("CMakeLists.txt"),
        "c2f0ee41a5702375da37e746d6dd4d3b3377119be1dd1b50e121c1540904a4a5",
        include_bytes!("cartridge_gundam/builder.cmake"),
    )?;
    let main = project.join("src/main.c");
    let bytes = crate::path::read_bounded_regular(&main, 256 * 1024)?;
    if digest(&bytes) != "699a5c993b5d0d4a5c8d1690bd78470e42274e3bb90eb7f0f4e8fc227c7c539f" {
        return Err(PortcoveError::verification(
            "fixed Gundam host preimage changed",
        ));
    }
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| PortcoveError::verification("fixed Gundam host is not UTF-8"))?;
    let start = text
        .find("static const char *game_config_path(void)\n{")
        .ok_or_else(|| PortcoveError::verification("fixed Gundam config resolver is absent"))?;
    let end = text[start..]
        .find("\nstatic int game_config_str(")
        .map(|offset| start + offset)
        .ok_or_else(|| PortcoveError::verification("fixed Gundam config resolver end is absent"))?;
    let patched = format!(
        "{}static const char *game_config_path(void)\n{{\n    return \"config.ini\";\n}}\n{}",
        &text[..start],
        &text[end..]
    );
    if digest(patched.as_bytes())
        != "c119916cd6be52b6bd207b20607b95d90bc35e24a53b6782641fe6aaac6d75d8"
    {
        return Err(PortcoveError::verification(
            "fixed Gundam config patch changed",
        ));
    }
    let start = patched
        .find("static void gwed_publish_identity(void)\n{")
        .ok_or_else(|| PortcoveError::verification("fixed Gundam identity logger is absent"))?;
    let end = patched[start..]
        .find("\nint main(int argc, char **argv)")
        .map(|offset| start + offset)
        .ok_or_else(|| PortcoveError::verification("fixed Gundam identity logger end is absent"))?;
    // This offline target has no mod/network identity to publish. Keep its
    // actual build identity in the log without linking optional mod loaders.
    let patched = format!(
        "{}static void gwed_publish_identity(void)\n{{\n    fprintf(stderr, \"game: stock offline build=%s; optional mods/netplay disabled\\n\", GWED_BUILD_ID);\n}}\n{}",
        &patched[..start],
        &patched[end..]
    );
    if digest(patched.as_bytes())
        != "7812ec436e59af08429b50be83fff1c1b3c6b7e08449e7b283538cf6485a2297"
    {
        return Err(PortcoveError::verification(
            "fixed Gundam offline identity patch changed",
        ));
    }
    replace_pinned(&main, &digest(&bytes), patched.as_bytes())?;
    write_new(
        &project.join("src/portcove_no_mods.c"),
        include_bytes!("cartridge_gundam/no_mods.c"),
    )?;
    checkpoint()
}

fn replace_pinned(path: &Path, expected: &str, replacement: &[u8]) -> Result<()> {
    let bytes = crate::path::read_bounded_regular(path, 256 * 1024)?;
    if digest(&bytes) != expected {
        return Err(PortcoveError::verification(
            "fixed Gundam patch preimage changed",
        ));
    }
    // Only the copied unpublished project is edited. Authenticated roots and
    // any previously installed game remain outside this patch boundary.
    std::fs::write(path, replacement)?;
    Ok(())
}

pub(super) fn analyzer_arguments(path: &Path) -> Result<Vec<String>> {
    Ok(vec!["--coff-imports".into(), cmake_path(path)?])
}

pub(super) fn analyzer_imports(output: &str) -> Result<Vec<String>> {
    let mut names = output
        .lines()
        .filter_map(|line| {
            line.trim()
                .strip_prefix("Name:")
                .map(|name| name.trim().to_ascii_lowercase())
        })
        .collect::<Vec<_>>();
    names.sort();
    if names
        != [
            "api-ms-win-core-synch-l1-2-0.dll",
            "bcryptprimitives.dll",
            "kernel32.dll",
            "ntdll.dll",
        ]
    {
        return Err(PortcoveError::verification(
            "fixed Gundam analyzer imports changed",
        ));
    }
    Ok(names)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn analyzer_requires_its_complete_exact_import_inventory() {
        let imports = "Name: bcryptprimitives.dll\nName: api-ms-win-core-synch-l1-2-0.dll\nName: KERNEL32.dll\nName: ntdll.dll\n";
        assert_eq!(analyzer_imports(imports).unwrap().len(), 4);
        for changed in [
            imports.replace("Name: ntdll.dll\n", ""),
            format!("{imports}Name: SDL2.dll\n"),
            format!("{imports}Name: ntdll.dll\n"),
            String::new(),
        ] {
            assert!(analyzer_imports(&changed).is_err());
        }
    }
}
