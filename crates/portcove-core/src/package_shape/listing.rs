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
//! authorizes a runtime; the worker uses it only to veto one. It adds a
//! listing-only tool-name veto ([`listing_tool_token`]) for asset names and
//! player program names, and a listing-only system-name veto
//! ([`listing_system_token`]) for asset names. Managed routes keep the shared
//! classifier unchanged.
//!
//! A player's machine here is platform-true
//! ([`machine::ExecutableImage::platform_machine`]): an image built for another
//! system than its format's desktop host is named with that system, so it can
//! never be read as a Windows, Linux or macOS program. A Mach-O image without
//! a platform load command is placed by its package structure
//! ([`mach_o_structure`]).

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
    /// The platform-true header machine, for example `pe-x86-64`,
    /// `elf64-android-arm64` or `macho-ios-arm64`.
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
        let system = match image.system {
            Some("unplatformed") | None if image.machine.starts_with("macho-") => {
                mach_o_structure(relative, image.system)
            }
            system => system,
        };
        let named = machine::ExecutableImage { system, ..image }.platform_machine();
        if !machine::is_machine_name(&named) {
            return Err(PortcoveError::verification(
                "a player's machine has no recognized name",
            ));
        }
        player_candidates.push(ListingPlayerCandidate {
            path: relative.clone(),
            display_path: display.clone(),
            machine: named,
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

/// Whether a lowercase package path is shaped like an iOS application: any
/// directory named `Payload` at any depth (an `.ipa` layout, also when the
/// `.ipa` was repacked inside another folder), or an `.app`/`.appex` bundle
/// ancestor that is not a macOS bundle. The innermost bundle ancestor of a
/// macOS program is always followed by `Contents/MacOS/`, and every outer one
/// by `Contents/`; an iOS bundle holds its program and nested extensions
/// directly.
fn ios_shaped(path: &str) -> bool {
    let parts = path.split('/').collect::<Vec<_>>();
    let directories = &parts[..parts.len().saturating_sub(1)];
    if directories.contains(&"payload") {
        return true;
    }
    let bundles = directories
        .iter()
        .enumerate()
        .filter(|(_, part)| part.ends_with(".app") || part.ends_with(".appex"))
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    bundles.iter().enumerate().any(|(position, &index)| {
        let innermost = position + 1 == bundles.len();
        let contents = parts.get(index + 1) == Some(&"contents");
        let macos = parts.get(index + 2) == Some(&"macos");
        !(contents && (!innermost || macos))
    })
}

/// The system a Mach-O player is placed on by its package structure. An
/// image whose load commands say macOS stays macOS unless its path is shaped
/// like an iOS application, which leaves it `unknown`. An image with no
/// platform load command is macOS only under `*.app/Contents/MacOS/` or as a
/// bare program outside any iOS-shaped location; otherwise it stays
/// `unplatformed`.
pub(crate) fn mach_o_structure(path: &str, system: Option<&'static str>) -> Option<&'static str> {
    match system {
        None if ios_shaped(path) => Some("unknown"),
        None => None,
        Some("unplatformed") if !ios_shaped(path) => None,
        other => other,
    }
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

/// Release tags, asset names and player program names to classify.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ListingNamesInput {
    #[serde(default)]
    pub releases: Vec<ListingReleaseName>,
    #[serde(default)]
    pub assets: Vec<String>,
    /// Player program file names (basenames) found inside archives.
    #[serde(default)]
    pub programs: Vec<String>,
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
    /// Each program name in input order with the tool token that excludes it.
    pub programs: Vec<ListingProgramVerdict>,
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
    /// The listing-only tool token the name carries; any token vetoes the
    /// whole archive.
    pub tool_token: Option<String>,
    /// The listing-only non-desktop system token the name carries; any token
    /// vetoes the whole archive.
    pub system_token: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ListingProgramVerdict {
    pub name: String,
    /// The listing-only tool token the program name carries; any token
    /// excludes that player candidate only.
    pub tool_token: Option<String>,
}

/// Tool words matched as whole words, camel-case words or two adjacent words
/// joined (`Crash` `Handler` is `crashhandler`), case-insensitively. Each marks
/// a program that is not the game itself, so registering it would start the
/// wrong program. Words that also name real game ports stay out: `recomp`,
/// `recompiled`, `psxrecomp`, `launcher` and `demo` are not vetoed.
pub const LISTING_TOOL_TOKENS: &[&str] = &[
    // Patching and ROM tooling: needs the player's own input and changes it.
    "patcher",
    "randomizer",
    "recompiler",
    "decompiler",
    "disassembler",
    "n64recomp",
    // Installation, update and crash handling programs beside the game.
    "setup",
    "installer",
    "uninstall",
    "uninstaller",
    "updater",
    "autoupdater",
    "crashhandler",
    "crashreporter",
    "crashpad",
    "crashsender",
    // Development and asset tools.
    "builder",
    "compiler",
    "importer",
    "extractor",
    "unpacker",
    "converter",
    "editor",
    "viewer",
    "debugger",
    "benchmark",
    "configurator",
    "modmanager",
    "sdk",
    "devkit",
    "tool",
    "tools",
    "toolkit",
    "server",
];
/// Tool words matched only as whole words between separators, because as a
/// camel-case word they also start real titles (`PatchQuest`).
pub const LISTING_DELIMITED_TOOL_TOKENS: &[&str] = &["patch"];

/// Systems Portcove offers no desktop route for, matched only as a whole
/// separator-delimited word or two adjacent words joined (`android-tv`,
/// `Wii U`), case-insensitively. Never a camel-case part or substring, so a
/// title such as `HaikuQuest` or `Switchblade` is not vetoed. The first group
/// is the shared classifier's own set.
pub const LISTING_SYSTEM_TOKENS: &[&str] = &[
    "android",
    "ios",
    "switch",
    "vita",
    "wii",
    "portmaster",
    // Apple devices.
    "iphone",
    "ipad",
    "ipados",
    "tvos",
    "watchos",
    "visionos",
    // Other operating systems.
    "freebsd",
    "openbsd",
    "netbsd",
    "haiku",
    "androidtv",
    // Consoles and handhelds.
    "ps3",
    "ps4",
    "ps5",
    "psp",
    "psvita",
    "xbox",
    "wiiu",
    "3ds",
    "nds",
];

/// The listing-only non-desktop system token a file name carries, if any.
pub fn listing_system_token(name: &str) -> Option<&'static str> {
    let (delimited, _) = name_words(name);
    let joined = delimited
        .windows(2)
        .map(|pair| pair.concat())
        .collect::<Vec<_>>();
    delimited.iter().chain(&joined).find_map(|word| {
        LISTING_SYSTEM_TOKENS
            .iter()
            .copied()
            .find(|token| *token == word.as_str())
    })
}

/// Words a name holds: separator-delimited words, their camel-case and
/// letter/digit parts, all lowercase.
fn name_words(name: &str) -> (Vec<String>, Vec<String>) {
    let delimited = name
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>();
    let mut parts = Vec::new();
    for word in &delimited {
        let characters = word.chars().collect::<Vec<_>>();
        let mut start = 0;
        for index in 1..characters.len() {
            let (previous, current) = (characters[index - 1], characters[index]);
            let next = characters.get(index + 1).copied();
            let boundary = (previous.is_ascii_lowercase() && current.is_ascii_uppercase())
                || (previous.is_ascii_alphabetic() && current.is_ascii_digit())
                || (previous.is_ascii_digit() && current.is_ascii_alphabetic())
                || (previous.is_ascii_uppercase()
                    && current.is_ascii_uppercase()
                    && next.is_some_and(|next| next.is_ascii_lowercase()));
            if boundary {
                parts.push(characters[start..index].iter().collect::<String>());
                start = index;
            }
        }
        parts.push(characters[start..].iter().collect::<String>());
    }
    (
        delimited
            .iter()
            .map(|word| word.to_ascii_lowercase())
            .collect(),
        parts.iter().map(|part| part.to_ascii_lowercase()).collect(),
    )
}

/// The listing-only tool token a file name carries, if any.
pub fn listing_tool_token(name: &str) -> Option<&'static str> {
    let (delimited, parts) = name_words(name);
    let joined = delimited
        .windows(2)
        .chain(parts.windows(2))
        .map(|pair| pair.concat())
        .collect::<Vec<_>>();
    let among = |tokens: &'static [&'static str], word: &String| {
        tokens.iter().copied().find(|token| *token == word.as_str())
    };
    delimited
        .iter()
        .chain(&parts)
        .chain(&joined)
        .find_map(|word| among(LISTING_TOOL_TOKENS, word))
        .or_else(|| {
            delimited
                .iter()
                .find_map(|word| among(LISTING_DELIMITED_TOOL_TOKENS, word))
        })
}

/// Classify release tags, asset names and program names with Core's reviewed
/// rules only.
pub fn classify_listing_names(input: &ListingNamesInput) -> Result<ListingNamesClassification> {
    if input.releases.len() + input.assets.len() + input.programs.len() > MAXIMUM_CLASSIFIED_NAMES
        || input
            .releases
            .iter()
            .map(|release| release.tag.as_str())
            .chain(input.assets.iter().map(String::as_str))
            .chain(input.programs.iter().map(String::as_str))
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
                    tool_token: listing_tool_token(name).map(str::to_owned),
                    system_token: listing_system_token(name).map(str::to_owned),
                }
            })
            .collect(),
        programs: input
            .programs
            .iter()
            .map(|name| ListingProgramVerdict {
                name: name.clone(),
                tool_token: listing_tool_token(name).map(str::to_owned),
            })
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::super::machine::fixtures::{
        LINUX_INTERPRETER, elf64, elf64_for, mach_o, mach_o_for, pe_subsystem, universal_of,
    };

    /// A Windows console-subsystem PE image.
    fn pe(machine: u16, characteristics: u16) -> Vec<u8> {
        pe_subsystem(machine, characteristics, 3)
    }
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

    fn platform_machine(bytes: &[u8]) -> String {
        machine::classify(&mut std::io::Cursor::new(bytes))
            .unwrap()
            .unwrap()
            .platform_machine()
    }

    const ARM64: u32 = 0x0100_000c;
    const X86_64: u32 = 0x0100_0007;
    const EXECUTE: u32 = 2;

    #[test]
    fn executable_systems_are_read_from_the_headers_and_named_platform_true() {
        // (bytes, platform-true machine, the historical machine name).
        let cases = [
            (pe(0x8664, EXECUTABLE), "pe-x86-64"),
            (
                super::super::machine::fixtures::pe(0x8664, EXECUTABLE),
                "pe-unknown-x86-64",
            ),
            (pe_subsystem(0x8664, EXECUTABLE, 2), "pe-x86-64"),
            (pe_subsystem(0x8664, EXECUTABLE, 14), "pe-xbox-x86-64"),
            (pe_subsystem(0x8664, EXECUTABLE, 10), "pe-efi-x86-64"),
            (pe_subsystem(0x8664, EXECUTABLE, 1), "pe-unknown-x86-64"),
            // An x64-headed image with CHPE metadata is ARM64EC, built for
            // Windows on Arm; without the metadata it stays plain x86-64.
            (
                super::super::machine::fixtures::pe_hybrid(0x1_4000_2000),
                "pe-arm64ec-x86-64",
            ),
            (super::super::machine::fixtures::pe_hybrid(0), "pe-x86-64"),
            (elf64(3, 62, true), "elf64-x86-64"),
            (
                elf64_for(2, 62, 0, Some("/lib/ld-musl-x86_64.so.1")),
                "elf64-x86-64",
            ),
            (elf64_for(2, 62, 3, None), "elf64-x86-64"),
            (elf64_for(2, 62, 3, Some(LINUX_INTERPRETER)), "elf64-x86-64"),
            (elf64_for(2, 62, 0, None), "elf64-unknown-x86-64"),
            (
                elf64_for(3, 183, 0, Some("/system/bin/linker64")),
                "elf64-android-arm64",
            ),
            (
                elf64_for(3, 62, 0, Some("/system/bin/linker64")),
                "elf64-android-x86-64",
            ),
            (
                elf64_for(2, 62, 9, Some("/libexec/ld-elf.so.1")),
                "elf64-freebsd-x86-64",
            ),
            (elf64_for(2, 62, 9, None), "elf64-freebsd-x86-64"),
            (
                elf64_for(2, 62, 9, Some(LINUX_INTERPRETER)),
                "elf64-unknown-x86-64",
            ),
            (
                elf64_for(3, 62, 0, Some("/usr/libexec/ld.so")),
                "elf64-openbsd-x86-64",
            ),
            (
                elf64_for(3, 62, 0, Some("/usr/libexec/ld.elf_so")),
                "elf64-netbsd-x86-64",
            ),
            (
                elf64_for(3, 62, 0, Some("/system/runtime_loader")),
                "elf64-haiku-x86-64",
            ),
            (
                elf64_for(3, 62, 0, Some("/opt/loader")),
                "elf64-unknown-x86-64",
            ),
            (mach_o_for(ARM64, EXECUTE, 1, false), "macho-arm64"),
            (mach_o_for(ARM64, EXECUTE, 6, false), "macho-arm64"),
            (mach_o_for(X86_64, EXECUTE, 0x24, true), "macho-x86-64"),
            (mach_o_for(ARM64, EXECUTE, 2, false), "macho-ios-arm64"),
            (mach_o_for(X86_64, EXECUTE, 7, false), "macho-ios-x86-64"),
            (mach_o_for(ARM64, EXECUTE, 0x25, true), "macho-ios-arm64"),
            (mach_o_for(ARM64, EXECUTE, 3, false), "macho-tvos-arm64"),
            (
                mach_o_for(ARM64, EXECUTE, 0x30, true),
                "macho-watchos-arm64",
            ),
            (
                mach_o_for(ARM64, EXECUTE, 11, false),
                "macho-visionos-arm64",
            ),
            (mach_o_for(ARM64, EXECUTE, 10, false), "macho-other-arm64"),
            (mach_o_for(ARM64, EXECUTE, 99, false), "macho-unknown-arm64"),
            (mach_o(ARM64, EXECUTE), "macho-unplatformed-arm64"),
            (
                universal_of(&[
                    mach_o_for(ARM64, EXECUTE, 1, false),
                    mach_o_for(X86_64, EXECUTE, 1, false),
                ]),
                "macho-universal-arm64+x86-64",
            ),
            (
                universal_of(&[
                    mach_o_for(ARM64, EXECUTE, 2, false),
                    mach_o_for(X86_64, EXECUTE, 7, false),
                ]),
                "macho-ios-universal-arm64+x86-64",
            ),
            (
                universal_of(&[
                    mach_o_for(ARM64, EXECUTE, 2, false),
                    mach_o_for(X86_64, EXECUTE, 1, false),
                ]),
                "macho-unknown-universal-arm64+x86-64",
            ),
            (
                universal_of(&[
                    mach_o(ARM64, EXECUTE),
                    mach_o_for(X86_64, EXECUTE, 1, false),
                ]),
                "macho-unplatformed-universal-arm64+x86-64",
            ),
        ];
        for (bytes, expected) in cases {
            let named = platform_machine(&bytes);
            assert_eq!(named, expected);
            assert!(machine::is_machine_name(&named), "{named}");
        }
        // The historical name says nothing about the system and is unchanged.
        let image = machine::classify(&mut std::io::Cursor::new(mach_o_for(
            ARM64, EXECUTE, 2, false,
        )))
        .unwrap()
        .unwrap();
        assert_eq!(image.machine, "macho-arm64");
    }

    #[test]
    fn mach_o_without_a_platform_command_is_placed_by_its_package_structure() {
        for (path, system) in [
            ("game.app/contents/macos/game", None),
            ("dist/game", None),
            ("game", None),
            ("payload/game.app/game", Some("unplatformed")),
            ("payload/game", Some("unplatformed")),
            ("game.app/game", Some("unplatformed")),
            // A `Payload` directory at any depth is an iOS layout.
            ("release/payload/game.app/game", Some("unplatformed")),
            ("dist/ios/payload/game", Some("unplatformed")),
            ("payload/game.app/contents/macos/game", Some("unplatformed")),
            // A bundle not followed by `Contents/MacOS` is iOS-shaped at any
            // depth, also an app extension.
            ("dist/game.app/game", Some("unplatformed")),
            ("game.app/plugins/widget.appex/widget", Some("unplatformed")),
            ("widget.appex/widget", Some("unplatformed")),
            ("game.app/contents/resources/game", Some("unplatformed")),
            // macOS bundles, including nested helpers and extensions.
            ("dist/game.app/contents/macos/game", None),
            (
                "game.app/contents/plugins/widget.appex/contents/macos/widget",
                None,
            ),
            (
                "game.app/contents/frameworks/helper.app/contents/macos/helper",
                None,
            ),
            // A file merely named like a bundle is not a bundle ancestor.
            ("dist/payload", None),
        ] {
            assert_eq!(
                mach_o_structure(path, Some("unplatformed")),
                system,
                "{path}"
            );
        }
        // Load commands saying macOS do not survive an iOS-shaped location.
        assert_eq!(
            mach_o_structure("payload/game.app/game", None),
            Some("unknown")
        );
        assert_eq!(mach_o_structure("game.app/contents/macos/game", None), None);
        assert_eq!(
            mach_o_structure("build/payload/game.app/game", None),
            Some("unknown")
        );
        assert_eq!(
            mach_o_structure("game.app/plugins/widget.appex/widget", None),
            Some("unknown")
        );
        assert_eq!(mach_o_structure("x/payload/game", Some("ios")), Some("ios"));
    }

    #[test]
    fn neutral_named_non_desktop_archives_record_non_desktop_machines() {
        for (entries, expected) in [
            // An iOS application with no telling name.
            (
                vec![(
                    "Payload/Game.app/Game",
                    mach_o_for(ARM64, EXECUTE, 2, false),
                )],
                vec!["macho-ios-arm64"],
            ),
            // The same layout without any platform command.
            (
                vec![("Payload/Game.app/Game", mach_o(ARM64, EXECUTE))],
                vec!["macho-unplatformed-arm64"],
            ),
            (
                vec![("Game.app/Game", mach_o(ARM64, EXECUTE))],
                vec!["macho-unplatformed-arm64"],
            ),
            // A macOS bundle without a platform command is still macOS.
            (
                vec![("Game.app/Contents/MacOS/Game", mach_o(ARM64, EXECUTE))],
                vec!["macho-arm64"],
            ),
            (
                vec![(
                    "game/game",
                    elf64_for(2, 62, 9, Some("/libexec/ld-elf.so.1")),
                )],
                vec!["elf64-freebsd-x86-64"],
            ),
            (
                vec![(
                    "game/game",
                    elf64_for(3, 62, 0, Some("/system/bin/linker64")),
                )],
                vec!["elf64-android-x86-64"],
            ),
            (
                vec![("game/game", elf64_for(2, 62, 0, None))],
                vec!["elf64-unknown-x86-64"],
            ),
            (
                vec![("Game.exe", pe_subsystem(0x8664, EXECUTABLE, 14))],
                vec!["pe-xbox-x86-64"],
            ),
        ] {
            let (_temporary, path, size, digest) = archive(&entries);
            let inspection =
                inspect_listing_artifact_archive(&path, Platform::WindowsX86_64, size, &digest)
                    .unwrap();
            let machines = inspection
                .player_candidates
                .iter()
                .map(|player| player.machine.as_str())
                .collect::<Vec<_>>();
            assert_eq!(machines, expected, "{entries:?}");
        }
    }

    #[test]
    fn system_tokens_veto_whole_words_only() {
        for (name, token) in [
            ("Game-v1.0-iphone.zip", "iphone"),
            ("Game_iPad.zip", "ipad"),
            ("Game-v1.0-ipados.zip", "ipados"),
            ("Game-tvOS.zip", "tvos"),
            ("Game-watchOS.zip", "watchos"),
            ("Game-visionOS.zip", "visionos"),
            ("Game-v1.0-freebsd-x86_64.tar.gz", "freebsd"),
            ("Game-openbsd.tar.gz", "openbsd"),
            ("Game-netbsd.tar.gz", "netbsd"),
            ("Game-haiku.zip", "haiku"),
            ("Game-v1.0-ps4.zip", "ps4"),
            ("Game-PS5.zip", "ps5"),
            ("Game-xbox.zip", "xbox"),
            ("Game-3ds.zip", "3ds"),
            ("Game-nds.zip", "nds"),
            ("Game-psp.zip", "psp"),
            ("Game-v1.0-android.zip", "android"),
            ("Game-v1.0-android-tv.zip", "android"),
            ("Game-androidtv.zip", "androidtv"),
            ("Game-Wii-U.zip", "wii"),
            ("Game-WiiU.zip", "wiiu"),
            ("Game-switch.zip", "switch"),
        ] {
            assert_eq!(listing_system_token(name), Some(token), "{name}");
        }
        for name in [
            "Game-v1.0-windows-x64.zip",
            "HaikuQuest-v1.0-windows-x64.zip",
            "Switchblade-v1.0-windows-x64.zip",
            "Xboxer.zip",
            "Androids-v1.0-linux-x86_64.tar.gz",
            "Game-v1.0-macos-universal.zip",
            "Pspan.zip",
        ] {
            assert_eq!(listing_system_token(name), None, "{name}");
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
            programs: Vec::new(),
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
            programs: Vec::new(),
        };
        assert!(classify_listing_names(&oversized).is_err());
        let oversized = ListingNamesInput {
            releases: Vec::new(),
            assets: Vec::new(),
            programs: vec!["a".repeat(MAXIMUM_CLASSIFIED_NAME_BYTES + 1)],
        };
        assert!(classify_listing_names(&oversized).is_err());
    }

    #[test]
    fn tool_names_are_vetoed_and_game_port_names_are_not() {
        for (name, token) in [
            ("Patcher-v1.0-windows-x64.zip", "patcher"),
            ("Patcher.exe", "patcher"),
            ("GamePatcher.exe", "patcher"),
            ("Game-v1.1-patch.zip", "patch"),
            ("SM64Randomizer.exe", "randomizer"),
            ("N64Recomp.exe", "n64recomp"),
            ("n64recomp-linux.tar.gz", "n64recomp"),
            ("RecompilerGUI.exe", "recompiler"),
            ("UnityCrashHandler64.exe", "crashhandler"),
            ("crashpad_handler.exe", "crashpad"),
            ("crash_reporter", "crashreporter"),
            ("GameUpdater.exe", "updater"),
            ("LevelEditor.exe", "editor"),
            ("AssetViewer", "viewer"),
            ("Mod-Manager.exe", "modmanager"),
            ("GameSetup.exe", "setup"),
            ("GameServer.x86_64", "server"),
            ("assets_extractor.exe", "extractor"),
        ] {
            assert_eq!(listing_tool_token(name), Some(token), "{name}");
        }
        for name in [
            "Game-v1.0-windows-x64.zip",
            "Zelda64Recompiled.exe",
            "MarioKart64Recomp-v1.0-windows.zip",
            "PSXRecomp.exe",
            "Game Launcher.exe",
            "GameDemo.exe",
            "PatchQuest.exe",
            "PatchQuest-v1.0-windows-x64.zip",
            "Dispatcher.exe",
            "Toolbox.exe",
            "Game.x86_64",
            "UnseenGame-v2.0-linux-x86_64.tar.xz",
        ] {
            assert_eq!(listing_tool_token(name), None, "{name}");
        }
        let output = classify_listing_names(&ListingNamesInput {
            releases: Vec::new(),
            assets: vec!["Patcher-v1.0-windows-x64.zip".into()],
            programs: vec!["Game.exe".into(), "Patcher.exe".into()],
        })
        .unwrap();
        // The shared classifier still calls it a desktop package.
        assert_eq!(output.assets[0].role, ArtifactRole::DesktopGameRuntime);
        assert_eq!(output.assets[0].tool_token.as_deref(), Some("patcher"));
        assert_eq!(output.programs[0].tool_token, None);
        assert_eq!(output.programs[1].tool_token.as_deref(), Some("patcher"));
    }

    // -----------------------------------------------------------------------
    // Forged-fact guard: every recorded fact the generated registration route
    // reads must equal what Core's own rules compute for it. This needs no
    // network: names, tags, paths and machines are all in the table.

    /// (target OS, architecture) of a platform-true machine name, in the
    /// facts' vocabulary; the worker's `machineSystem` restated.
    fn machine_system(machine: &str) -> (&'static str, &'static str) {
        let (format, rest) = machine.split_once('-').unwrap_or(("", ""));
        let (host, systems) = match format {
            "pe" => ("windows", machine::PE_SYSTEMS),
            "elf32" | "elf64" | "elf32be" | "elf64be" => ("linux", machine::ELF_SYSTEMS),
            "macho" => ("macos", machine::MACH_O_SYSTEMS),
            _ => ("unknown", &[][..]),
        };
        let (system, rest) = systems
            .iter()
            .find_map(|system| {
                rest.strip_prefix(system)
                    .and_then(|after| after.strip_prefix('-'))
                    .map(|after| (*system, after))
            })
            .unwrap_or((host, rest));
        let os = match system {
            "windows" | "linux" | "macos" | "android" => system,
            "arm64ec" => "windows",
            "ios" | "tvos" | "watchos" | "visionos" => "ios",
            "xbox" => "console",
            _ => "unknown",
        };
        let arch = if system == "arm64ec" {
            "aarch64"
        } else if rest.starts_with("universal-") {
            "universal"
        } else {
            match rest {
                "arm64" => "aarch64",
                "x86-64" => "x86-64",
                "x86" => "x86",
                _ => "unknown",
            }
        };
        (os, arch)
    }

    fn agreed(values: impl Iterator<Item = &'static str>) -> &'static str {
        let values = values.collect::<Vec<_>>();
        match values.first() {
            Some(first) if values.iter().all(|value| value == first) => first,
            _ => "unknown",
        }
    }

    fn arch_agrees(named: &str, actual: &str) -> bool {
        named == "unknown"
            || named == actual
            || (actual == "universal" && (named == "x86-64" || named == "aarch64"))
    }

    fn basename(path: &str) -> &str {
        path.rsplit('/').next().unwrap_or(path)
    }

    /// Facts in `table` that Core's rules contradict.
    fn facts_problems(table: &serde_json::Value) -> Vec<String> {
        let mut problems = Vec::new();
        let text = |value: &serde_json::Value| value.as_str().unwrap_or_default().to_owned();
        for entry in table["entries"].as_array().into_iter().flatten() {
            let id = text(&entry["port_id"]);
            if entry["ineligible"].is_null()
                && let Some(tag) = entry["observation"]["tag"].as_str()
                && crate::release::is_prerelease(false, tag)
            {
                problems.push(format!(
                    "{id}: release {tag} is a prerelease by Core's rule"
                ));
            }
            for artifact in entry["artifacts"].as_array().into_iter().flatten() {
                let name = text(&artifact["name"]);
                let at = format!("{id} {name}");
                let players = artifact["players"].as_array().cloned().unwrap_or_default();
                let excluded = artifact["excluded_players"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                let programs = players
                    .iter()
                    .chain(&excluded)
                    .map(|player| basename(&text(&player["display_path"])).to_owned())
                    .collect::<Vec<_>>();
                let output = classify_listing_names(&ListingNamesInput {
                    releases: Vec::new(),
                    assets: vec![name.clone()],
                    programs,
                })
                .unwrap();
                let suggestion = &output.assets[0];
                let expected = serde_json::json!({
                    "rule_version": FILENAME_RULE_VERSION,
                    "role": suggestion.role,
                    "os": suggestion.os,
                    "arch": suggestion.arch,
                    "tool_token": suggestion.tool_token,
                    "system_token": suggestion.system_token,
                });
                if artifact["name_suggestion"] != expected {
                    problems.push(format!("{at}: name suggestion differs from Core's"));
                }
                for (index, player) in players.iter().chain(&excluded).enumerate() {
                    let path = text(&player["path"]);
                    let machine = text(&player["machine"]);
                    let windows_program = path.ends_with(".exe");
                    if !machine::is_machine_name(&machine)
                        || windows_program != machine.starts_with("pe-")
                    {
                        problems.push(format!("{at}: {path} has no producible {machine}"));
                    }
                    if crate::route_facts::player_candidates(std::slice::from_ref(&path)).is_empty()
                    {
                        problems.push(format!("{at}: {path} is not a player candidate path"));
                    }
                    // A macOS machine is never recorded for an iOS-shaped path.
                    if machine.starts_with("macho-")
                        && machine_system(&machine).0 == "macos"
                        && mach_o_structure(&path, None).is_some()
                    {
                        problems.push(format!("{at}: {path} is iOS-shaped but recorded as macOS"));
                    }
                    let token = output.programs[index].tool_token.as_deref();
                    let recorded = player.get("token").and_then(serde_json::Value::as_str);
                    if token != recorded {
                        problems.push(format!("{at}: {path} tool token differs from Core's"));
                    }
                }
                let machines = players
                    .iter()
                    .map(|player| text(&player["machine"]))
                    .collect::<Vec<_>>();
                let systems = machines
                    .iter()
                    .map(|machine| machine_system(machine))
                    .collect::<Vec<_>>();
                let os = agreed(systems.iter().map(|(os, _)| *os));
                let arch = agreed(systems.iter().map(|(_, arch)| *arch));
                let named_os = serde_json::to_value(suggestion.os).unwrap();
                let named_arch = serde_json::to_value(suggestion.arch).unwrap();
                let named_role = serde_json::to_value(suggestion.role).unwrap();
                let named_os = named_os.as_str().unwrap_or_default();
                let named_arch = named_arch.as_str().unwrap_or_default();
                let contradictory = !players.is_empty()
                    && (!(named_role == "desktop-game-runtime" || named_role == "unknown")
                        || suggestion.tool_token.is_some()
                        || suggestion.system_token.is_some()
                        || (named_os != "unknown"
                            && !systems.iter().any(|(os, _)| *os == named_os))
                        || !systems
                            .iter()
                            .any(|(_, arch)| arch_agrees(named_arch, arch)));
                let role = if players.is_empty() {
                    "unknown"
                } else {
                    "desktop-game-runtime"
                };
                if artifact["contradictory"] != contradictory
                    || artifact["role"] != role
                    || artifact["os"] != os
                    || artifact["arch"] != arch
                {
                    problems.push(format!("{at}: role, system or contradiction differs"));
                }
            }
        }
        problems
    }

    #[test]
    fn committed_listing_facts_equal_what_core_computes() {
        let table: serde_json::Value = serde_json::from_str(include_str!(
            "../../catalog/listing-package-facts.generated.json"
        ))
        .unwrap();
        assert_eq!(facts_problems(&table), Vec::<String>::new());
    }

    /// The worker's own output for a sample run, written by its tests.
    #[test]
    fn worker_sample_facts_equal_what_core_computes_and_forgeries_do_not() {
        let sample: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../scripts/fixtures/listing-package-facts-sample.json"
        ))
        .unwrap();
        assert!(
            sample["entries"]
                .as_array()
                .is_some_and(|entries| entries.iter().any(|entry| entry["artifacts"]
                    .as_array()
                    .is_some_and(|artifacts| !artifacts.is_empty()))),
            "the sample holds artifacts"
        );
        assert_eq!(facts_problems(&sample), Vec::<String>::new());
        let artifact = |table: &mut serde_json::Value| -> serde_json::Value {
            table["entries"]
                .as_array()
                .unwrap()
                .iter()
                .flat_map(|entry| entry["artifacts"].as_array().unwrap())
                .find(|artifact| !artifact["players"].as_array().unwrap().is_empty())
                .unwrap()
                .clone()
        };
        let forge = |change: &dyn Fn(&mut serde_json::Value)| {
            let mut table = sample.clone();
            let original = artifact(&mut table);
            for entry in table["entries"].as_array_mut().unwrap() {
                for candidate in entry["artifacts"].as_array_mut().unwrap() {
                    if *candidate == original {
                        change(candidate);
                    }
                }
            }
            facts_problems(&table)
        };
        let changes: [fn(&mut serde_json::Value); 8] = [
            |artifact| artifact["name"] = "Game-dedicated-server-windows-x64.zip".into(),
            |artifact| artifact["name_suggestion"]["tool_token"] = "patcher".into(),
            |artifact| artifact["name_suggestion"]["system_token"] = "ios".into(),
            |artifact| artifact["contradictory"] = true.into(),
            |artifact| artifact["players"][0]["machine"] = "pe-forged".into(),
            |artifact| artifact["players"][0]["path"] = "tools/game.exe".into(),
            |artifact| artifact["players"][0]["display_path"] = "Patcher.exe".into(),
            |artifact| artifact["players"][0]["machine"] = "pe-xbox-x86-64".into(),
        ];
        for change in changes {
            assert!(!forge(&change).is_empty());
        }
        let mut prerelease = sample.clone();
        let entry = prerelease["entries"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|entry| entry["ineligible"].is_null())
            .unwrap();
        entry["observation"]["tag"] = "v2.0-nightly".into();
        assert!(!facts_problems(&prerelease).is_empty());
    }

    #[test]
    fn machine_names_are_the_ones_the_classifier_produces() {
        for machine in [
            "pe-x86-64",
            "pe-x86",
            "pe-0x01c2",
            "elf64-x86-64",
            "elf32be-arm",
            "macho-arm64",
            "macho-universal-arm64+x86-64",
            "macho-ios-arm64",
            "macho-unplatformed-universal-arm64+x86-64",
            "elf64-android-arm64",
            "elf32-unknown-x86",
            "pe-xbox-x86-64",
        ] {
            assert!(machine::is_machine_name(machine), "{machine}");
        }
        for machine in [
            "pe-",
            "pe-x86_64",
            "elf16-x86",
            "macho-universal-x86-64+arm64",
            "macho-universal-arm64+arm64",
            "pe-0x1",
            "macho-0x0100000C",
            "macho-android-arm64",
            "elf64-ios-arm64",
            "pe-linux-x86-64",
            "macho-ios-",
            "elf64-freebsd",
        ] {
            assert!(!machine::is_machine_name(machine), "{machine}");
        }
    }
}
