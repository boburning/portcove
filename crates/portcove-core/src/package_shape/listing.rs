//! Read-only player inspection of a listing's release archive.
//!
//! A listing-only identity has no operational route, so no declared launch
//! target exists to resolve. These exact verified bytes still establish which
//! native executables a package holds and for which machine. Each player
//! candidate is a regular file outside any tool, installer or server location
//! whose header classifies as a native executable. Nothing is executed, and
//! the result establishes structure only, never release or launch authority.
//!
//! [`classify_listing_names`] exposes the single filename classifier and the
//! reviewed prerelease tag rule to the facts worker. A filename never
//! authorizes a runtime; the worker uses it only to veto one.

use std::{
    fs,
    io::{Read as _, Seek as _},
    path::{Path, PathBuf},
};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::{MAXIMUM_SHAPE_PATHS, SHAPE_VERSION, machine};
use crate::route_facts::{ArtifactRole, FILENAME_RULE_VERSION, TargetArch, TargetOs};
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
    pub player_candidates: Vec<ListingPlayerCandidate>,
}

/// One native executable a listing archive holds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ListingPlayerCandidate {
    /// Lowercase `/`-joined package-relative path; the comparison key.
    pub path: String,
    /// The same path with the archive's own letter case, for display.
    pub display_path: String,
    /// The PE, ELF or Mach-O header machine, for example `pe-x86-64`.
    pub machine: String,
    pub sha256: String,
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
    for (relative, display, path) in &files {
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
        player_candidates.push(ListingPlayerCandidate {
            path: relative.clone(),
            display_path: display.clone(),
            machine: image.machine,
            sha256: hex::encode(sha2::Digest::finalize(digest)),
        });
    }
    Ok(ListingArtifactInspection {
        sha256: expected_sha256.to_ascii_lowercase(),
        shape_version: SHAPE_VERSION,
        files: files.len(),
        player_candidates,
    })
}

/// Regular files under `root` by lowercase `/`-joined relative path, with the
/// original-case path for display. Links and special files are never followed
/// or classified.
fn collect_files(
    root: &Path,
    directory: &Path,
    files: &mut Vec<(String, String, PathBuf)>,
) -> Result<()> {
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
            let display = path
                .strip_prefix(root)
                .ok()
                .and_then(|relative| {
                    relative
                        .components()
                        .map(|component| match component {
                            std::path::Component::Normal(part) => part.to_str(),
                            _ => None,
                        })
                        .collect::<Option<Vec<_>>>()
                })
                .ok_or_else(|| PortcoveError::verification("package path is not UTF-8"))?
                .join("/");
            files.push((display.to_ascii_lowercase(), display, path));
        }
    }
    Ok(())
}

/// Bounds of one name classification request.
const MAXIMUM_CLASSIFIED_NAMES: usize = 50_000;
const MAXIMUM_CLASSIFIED_NAME_BYTES: usize = 1024;

/// Release tags and asset names to classify.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ListingNamesInput {
    #[serde(default)]
    pub releases: Vec<ListingReleaseName>,
    #[serde(default)]
    pub assets: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ListingReleaseName {
    pub tag: String,
    pub provider_prerelease: bool,
}

/// Result of `catalog classify-listing-names`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ListingNamesClassification {
    /// Version of the filename suggestion rules.
    pub filename_rule_version: u32,
    /// Each release in input order with the reviewed prerelease verdict.
    pub releases: Vec<ListingReleaseVerdict>,
    /// Each asset name in input order with what its filename suggests. A
    /// suggestion never authorizes a runtime.
    pub assets: Vec<ListingNameSuggestion>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ListingReleaseVerdict {
    pub tag: String,
    pub provider_prerelease: bool,
    /// The provider flag, or a tag naming a prerelease stage.
    pub prerelease: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ListingNameSuggestion {
    pub name: String,
    pub role: ArtifactRole,
    pub os: TargetOs,
    pub arch: TargetArch,
}

/// Classify release tags and asset names with Core's reviewed rules only.
pub fn classify_listing_names(input: &ListingNamesInput) -> Result<ListingNamesClassification> {
    if input.releases.len() + input.assets.len() > MAXIMUM_CLASSIFIED_NAMES
        || input
            .releases
            .iter()
            .map(|release| release.tag.as_str())
            .chain(input.assets.iter().map(String::as_str))
            .any(|name| name.len() > MAXIMUM_CLASSIFIED_NAME_BYTES)
    {
        return Err(PortcoveError::usage(
            "listing name classification exceeds its bounds",
        ));
    }
    Ok(ListingNamesClassification {
        filename_rule_version: FILENAME_RULE_VERSION,
        releases: input
            .releases
            .iter()
            .map(|release| ListingReleaseVerdict {
                tag: release.tag.clone(),
                provider_prerelease: release.provider_prerelease,
                prerelease: crate::release::is_prerelease(
                    release.provider_prerelease,
                    &release.tag,
                ),
            })
            .collect(),
        assets: input
            .assets
            .iter()
            .map(|name| {
                let suggestion = crate::route_facts::suggest_from_filename(name);
                ListingNameSuggestion {
                    name: name.clone(),
                    role: suggestion.role,
                    os: suggestion.os,
                    arch: suggestion.arch,
                }
            })
            .collect(),
    })
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
            [ListingPlayerCandidate {
                path: "game/game.exe".into(),
                display_path: "Game/Game.exe".into(),
                machine: "pe-x86-64".into(),
                sha256: hex::encode(<sha2::Sha256 as sha2::Digest>::digest(&player)),
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

    /// The facts worker's tests replay this exact Core output, so the fixture
    /// must stay equal to what Core says about its names.
    #[test]
    fn name_classification_matches_the_worker_fixture() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../scripts/fixtures/listing-name-classification.json"
        ))
        .unwrap();
        let input: ListingNamesInput = serde_json::from_value(fixture["input"].clone()).unwrap();
        let output = serde_json::to_value(classify_listing_names(&input).unwrap()).unwrap();
        assert_eq!(output, fixture["output"]);
    }

    #[test]
    fn name_classification_vetoes_non_runtime_names_and_marks_prerelease_tags() {
        let input = ListingNamesInput {
            releases: vec![
                ListingReleaseName {
                    tag: "v2.0-nightly".into(),
                    provider_prerelease: false,
                },
                ListingReleaseName {
                    tag: "v1.0".into(),
                    provider_prerelease: false,
                },
            ],
            assets: vec![
                "MyGame-dedicated-server-win64.zip".into(),
                "MyGame-v1.0-windows-x64.zip".into(),
            ],
        };
        let output = classify_listing_names(&input).unwrap();
        assert!(output.releases[0].prerelease);
        assert!(!output.releases[1].prerelease);
        assert_eq!(output.assets[0].role, ArtifactRole::DedicatedServer);
        assert_eq!(output.assets[1].role, ArtifactRole::DesktopGameRuntime);
        assert_eq!(output.assets[1].os, TargetOs::Windows);
        assert_eq!(output.assets[1].arch, TargetArch::X86_64);
        let oversized = ListingNamesInput {
            releases: Vec::new(),
            assets: vec!["a".repeat(MAXIMUM_CLASSIFIED_NAME_BYTES + 1)],
        };
        assert!(classify_listing_names(&oversized).is_err());
    }
}
