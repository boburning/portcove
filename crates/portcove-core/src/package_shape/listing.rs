//! Read-only player inspection of a listing's release archive.
//!
//! A listing-only identity has no operational route, so no declared launch
//! target exists to resolve. These exact verified bytes still establish which
//! native executables a package holds and for which machine. Each player
//! candidate is a regular file outside any tool, installer or server location
//! whose header classifies as a native executable. Nothing is executed, and
//! the result establishes structure only, never release or launch authority.

use std::{
    fs,
    io::{Read as _, Seek as _},
    path::{Path, PathBuf},
};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::{MAXIMUM_SHAPE_PATHS, SHAPE_VERSION, machine};
use crate::{Platform, PortcoveError, Result};

/// Result of `catalog inspect-listing-artifact`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ListingArtifactInspection {
    pub sha256: String,
    /// Derivation version of the player rules, shared with package shapes.
    pub shape_version: u32,
    /// Regular files the archive holds.
    pub files: usize,
    /// Player candidates in path order, each with machine and SHA-256.
    pub player_candidates: Vec<crate::PlayerCandidate>,
}

/// Inspect verified archive bytes for player candidates without a route.
/// `platform` selects only the archive reader rules (for example, Unix modes).
pub fn inspect_listing_artifact_archive(
    source: &Path,
    platform: Platform,
    expected_size: u64,
    expected_sha256: &str,
) -> Result<ListingArtifactInspection> {
    let (_workspace, payload) = crate::package_layout::extract_verified_archive(
        source,
        platform,
        expected_size,
        expected_sha256,
        false,
    )?;
    let mut files = Vec::new();
    collect_files(&payload, &payload, &mut files)?;
    files.sort();
    let mut player_candidates = Vec::new();
    for (relative, path) in &files {
        if crate::route_facts::player_candidates(std::slice::from_ref(relative)).is_empty() {
            continue;
        }
        let mut file = crate::external_runtime::open_single_link_file(path)?;
        let Some(image) = machine::classify(&mut file)? else {
            continue;
        };
        if image.kind != machine::ImageKind::Executable {
            continue;
        }
        file.seek(std::io::SeekFrom::Start(0))?;
        let mut digest = <sha2::Sha256 as sha2::Digest>::new();
        let mut buffer = vec![0_u8; 64 * 1024];
        loop {
            let read = file.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            sha2::Digest::update(&mut digest, &buffer[..read]);
        }
        player_candidates.push(crate::PlayerCandidate {
            path: relative.clone(),
            machine: Some(image.machine),
            sha256: Some(hex::encode(sha2::Digest::finalize(digest))),
        });
    }
    Ok(ListingArtifactInspection {
        sha256: expected_sha256.to_ascii_lowercase(),
        shape_version: SHAPE_VERSION,
        files: files.len(),
        player_candidates,
    })
}

/// Regular files under `root` by lowercase `/`-joined relative path. Links and
/// special files are never followed or classified.
fn collect_files(root: &Path, directory: &Path, files: &mut Vec<(String, PathBuf)>) -> Result<()> {
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let path = entry.path();
        if kind.is_dir() {
            collect_files(root, &path, files)?;
        } else if kind.is_file() {
            if files.len() >= MAXIMUM_SHAPE_PATHS {
                return Err(PortcoveError::verification(
                    "package archive exceeds the inspected file bound",
                ));
            }
            let relative = path
                .strip_prefix(root)
                .ok()
                .and_then(|relative| {
                    relative
                        .components()
                        .map(|component| match component {
                            std::path::Component::Normal(part) => {
                                part.to_str().map(str::to_ascii_lowercase)
                            }
                            _ => None,
                        })
                        .collect::<Option<Vec<_>>>()
                })
                .ok_or_else(|| PortcoveError::verification("package path is not UTF-8"))?
                .join("/");
            files.push((relative, path));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::machine::fixtures::{elf64, pe};
    use super::*;
    use std::io::Write as _;

    fn archive(entries: &[(&str, Vec<u8>)]) -> (tempfile::TempDir, PathBuf, u64, String) {
        let temporary = tempfile::tempdir().unwrap();
        // Named like a desktop game package whatever its contents are.
        let path = temporary.path().join("Game-v1.0-windows-x64.zip");
        let mut writer = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        for (name, bytes) in entries {
            writer
                .start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap();
        let size = fs::metadata(&path).unwrap().len();
        let digest = crate::service::sha256_file(&path).unwrap();
        (temporary, path, size, digest)
    }

    const EXECUTABLE: u16 = 0x0002;
    const DLL: u16 = 0x2002;

    #[test]
    fn a_desktop_package_names_its_native_player_with_machine_and_digest() {
        let player = pe(0x8664, EXECUTABLE);
        let (_temporary, path, size, digest) = archive(&[
            ("Game/Game.exe", player.clone()),
            ("Game/engine.dll", pe(0x8664, DLL)),
            ("Game/data/readme.txt", b"text".to_vec()),
        ]);
        let inspection =
            inspect_listing_artifact_archive(&path, Platform::WindowsX86_64, size, &digest)
                .unwrap();
        assert_eq!(inspection.files, 3);
        assert_eq!(inspection.shape_version, SHAPE_VERSION);
        assert_eq!(
            inspection.player_candidates,
            [crate::PlayerCandidate {
                path: "game/game.exe".into(),
                machine: Some("pe-x86-64".into()),
                sha256: Some(hex::encode(<sha2::Sha256 as sha2::Digest>::digest(&player))),
            }]
        );
    }

    #[test]
    fn installers_builders_and_mobile_packages_named_like_desktop_zips_hold_no_player() {
        for entries in [
            vec![("setup.exe", pe(0x8664, EXECUTABLE))],
            vec![("Installer/GameInstaller.exe", pe(0x8664, EXECUTABLE))],
            vec![("tools/builder.exe", pe(0x8664, EXECUTABLE))],
            vec![
                ("AndroidManifest.xml", b"<manifest/>".to_vec()),
                ("classes.dex", b"dex\n035\0".to_vec()),
                ("lib/arm64-v8a/libgame.so", elf64(3, 183, false)),
            ],
            vec![("Game.exe.txt", b"not a program".to_vec())],
        ] {
            let (_temporary, path, size, digest) = archive(&entries);
            let inspection =
                inspect_listing_artifact_archive(&path, Platform::WindowsX86_64, size, &digest)
                    .unwrap();
            assert_eq!(inspection.player_candidates, [], "{entries:?}");
        }
    }

    #[test]
    fn bytes_that_differ_from_the_provider_digest_are_refused() {
        let (_temporary, path, size, _) = archive(&[("Game.exe", pe(0x8664, EXECUTABLE))]);
        let error =
            inspect_listing_artifact_archive(&path, Platform::WindowsX86_64, size, &"0".repeat(64))
                .unwrap_err();
        assert!(error.message.contains("SHA-256"), "{error:?}");
    }
}
