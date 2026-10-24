//! Suitability only: acquisition still refreshes immutable IDs and integrity policy.
use super::*;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CatalogDownloadRelease {
    pub id: u64,
    pub tag: String,
    pub preview: bool,
    pub assets_complete: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CatalogPackageAssessment {
    pub asset_id: u64,
    pub suitability: String,
    pub reason: String,
}

pub(super) fn assess_package(
    asset: &CatalogDownloadCandidate,
    platform: Platform,
    hints: &[String],
) -> (CatalogPackageAssessment, Option<u32>) {
    let (suitability, reason, score) =
        assess_package_name(&asset.name, asset.can_extract, platform, hints);
    (
        CatalogPackageAssessment {
            asset_id: asset.asset_id,
            suitability: suitability.into(),
            reason: reason.into(),
        },
        score,
    )
}

pub(crate) fn assess_package_name(
    name: &str,
    can_extract: bool,
    platform: Platform,
    hints: &[String],
) -> (&'static str, &'static str, Option<u32>) {
    let name = name.to_ascii_lowercase();
    let tokens = name
        .split(|c: char| !c.is_ascii_alphanumeric())
        .collect::<Vec<_>>();
    let has = |values: &[&str]| values.iter().any(|v| tokens.contains(v));
    let hinted = !hints.is_empty()
        && hints
            .iter()
            .all(|hint| name.contains(&hint.to_ascii_lowercase()));
    // Generic managed/platform hints must not turn a debug build into the
    // recommended release. A reviewed debug player needs its whole filename.
    let reviewed_debug_player = hinted && hints.iter().any(|hint| hint.eq_ignore_ascii_case(&name));
    let finish = |suitability, reason, score| (suitability, reason, score);
    let archive = [".zip", ".7z", ".tar.gz", ".tar.xz", ".tgz", ".rar"]
        .iter()
        .any(|ext| name.ends_with(ext));
    if has(&[
        "checksums",
        "checksum",
        "sha256sums",
        "sha512sums",
        "symbols",
        "pdb",
        "dsym",
    ]) || (!reviewed_debug_player && has(&["debug"]))
        || [
            ".sha256",
            ".sha512",
            ".sha1",
            ".md5",
            ".sig",
            ".asc",
            ".minisig",
            ".json",
            ".yml",
            ".yaml",
            ".blockmap",
            ".zsync",
            ".txt",
        ]
        .iter()
        .any(|ext| name.ends_with(ext))
        || (archive && has(&["source", "sources", "src", "notices"]))
        || is_license_compliance_archive(&name)
    {
        return finish(
            "auxiliary",
            "Checksums, signatures, source code or supporting metadata; not an installable game package.",
            None,
        );
    }
    let windows = has(&["windows", "win", "win32", "win64", "winx64"])
        || name.ends_with(".exe")
        || name.ends_with(".msi");
    let linux = has(&["linux", "appimage", "flatpak"])
        || [".appimage", ".deb", ".rpm"]
            .iter()
            .any(|ext| name.ends_with(ext));
    let mac =
        has(&["mac", "macos", "osx", "darwin"]) || name.ends_with(".dmg") || name.ends_with(".pkg");
    let foreign = has(&["android", "switch", "vita", "wii", "ios"]) || name.ends_with(".apk");
    let platform_match = match platform {
        Platform::WindowsX86_64 => windows && !linux && !mac,
        Platform::LinuxX86_64 => linux && !windows && !mac,
        Platform::MacosX86_64 | Platform::MacosAarch64 => mac && !windows && !linux,
    };
    if foreign || ((windows || linux || mac) && !platform_match) {
        return finish(
            "incompatible",
            "Named for another platform. Portcove does not offer a compatibility-layer launch route.",
            None,
        );
    }
    let arm = has(&["arm64", "aarch64"]);
    let intel = has(&["x64", "amd64", "win64", "winx64", "intel"])
        || name.contains("x86_64")
        || name.contains("x86-64");
    let legacy = has(&[
        "i386", "i686", "win32", "x32", "32bit", "arm", "armv6", "armv7", "armv8",
    ]) || name.contains("32-bit")
        || name.contains("32_bit")
        || (has(&["x86"]) && !intel);
    let universal = has(&["universal", "universal2"]) || (arm && intel);
    let wants_arm = platform == Platform::MacosAarch64;
    let reviewed_windows_x86 = hinted
        && platform == Platform::WindowsX86_64
        && windows
        && hints.iter().any(|hint| {
            let hint = hint.to_ascii_lowercase();
            hint.split(|c: char| !c.is_ascii_alphanumeric())
                .any(|token| ["i386", "i686", "win32", "x32", "32bit", "x86"].contains(&token))
                || hint.contains("32-bit")
                || hint.contains("32_bit")
        })
        && has(&["i386", "i686", "win32", "x32", "32bit", "x86"])
        && !has(&["arm", "armv6", "armv7", "armv8", "arm64", "aarch64"]);
    if legacy && !universal && !reviewed_windows_x86 {
        return finish(
            "emulation",
            "This build targets a different or older processor. Compatibility has not been established; prefer a native build or consult upstream.",
            None,
        );
    }
    if !universal && ((wants_arm && intel) || (!wants_arm && arm)) {
        return finish(
            if wants_arm && intel {
                "emulation"
            } else {
                "incompatible"
            },
            "Processor differs from this host. Emulation availability has not been established; choose a native build or consult upstream.",
            None,
        );
    }
    let supported_form = can_extract
        || [
            ".exe",
            ".msi",
            ".appimage",
            ".dmg",
            ".pkg",
            ".deb",
            ".rpm",
            ".7z",
            ".tar.xz",
        ]
        .iter()
        .any(|ext| name.ends_with(ext));
    if !supported_form || (!platform_match && !hinted) {
        return finish(
            "uncertain",
            "The package's native platform or format is not established. Check upstream instructions before choosing it.",
            None,
        );
    }
    if !universal && !intel && !arm && !hinted {
        return finish(
            "uncertain",
            "The processor for this package is unspecified. Choose a native build or check upstream requirements.",
            None,
        );
    }
    let score = u32::from(hinted) * 100
        + u32::from(can_extract) * 10
        + u32::from(universal || intel || arm) * 2;
    finish(
        "suitable",
        if hinted {
            "Matches the catalog's package hints for this host. Confirm upstream requirements."
        } else if can_extract {
            "Native platform package; Portcove can extract it without running setup."
        } else {
            "Native platform download; complete upstream setup before choosing its installed executable."
        },
        Some(score),
    )
}

pub(crate) fn is_license_compliance_archive(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    let tokens = name
        .split(|c: char| !c.is_ascii_alphanumeric())
        .collect::<Vec<_>>();
    [".zip", ".tar.gz", ".tgz", ".tar.xz", ".7z"]
        .iter()
        .any(|extension| name.ends_with(extension))
        && tokens.contains(&"compliance")
        && ["lgpl", "gpl", "license", "licenses"]
            .iter()
            .any(|token| tokens.contains(token))
}

pub(super) fn recommend_packages(
    assets: &[CatalogDownloadCandidate],
    platform: Platform,
    hints: &[String],
    complete: bool,
) -> (Vec<CatalogPackageAssessment>, Option<u64>) {
    let assessed = assets
        .iter()
        .map(|asset| assess_package(asset, platform, hints))
        .collect::<Vec<_>>();
    let mut ranked = assessed
        .iter()
        .filter_map(|(assessment, score)| score.map(|score| (score, assessment.asset_id)))
        .collect::<Vec<_>>();
    ranked.sort_by_key(|item| std::cmp::Reverse(item.0));
    let recommended = if complete
        && ranked
            .first()
            .is_some_and(|best| ranked.get(1).is_none_or(|next| best.0 > next.0))
    {
        ranked.first().map(|best| best.1)
    } else {
        None
    };
    (
        assessed
            .into_iter()
            .map(|(assessment, _)| assessment)
            .collect(),
        recommended,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn asset(id: u64, name: &str) -> CatalogDownloadCandidate {
        CatalogDownloadCandidate {
            release_id: 1,
            asset_id: id,
            release_tag: "v1".into(),
            release_url: String::new(),
            name: name.into(),
            size: 1,
            download_url: String::new(),
            sha256: None,
            can_extract: name.ends_with(".zip"),
        }
    }
    #[test]
    fn native_portable_wins_without_hiding_other_downloads() {
        let assets = [
            asset(1, "game-windows-x64.zip"),
            asset(2, "game-windows-x64.msi"),
            asset(3, "game-linux-x64.zip"),
            asset(4, "game-windows-arm64.zip"),
            asset(5, "game-source.zip"),
            asset(6, "game-windows-x64.zip.sha256"),
        ];
        let (options, recommendation) =
            recommend_packages(&assets, Platform::WindowsX86_64, &[], true);
        assert_eq!(recommendation, Some(1));
        assert_eq!(
            options
                .iter()
                .map(|a| a.suitability.as_str())
                .collect::<Vec<_>>(),
            [
                "suitable",
                "suitable",
                "incompatible",
                "incompatible",
                "auxiliary",
                "auxiliary"
            ]
        );
        assert_eq!(
            recommend_packages(&assets, Platform::WindowsX86_64, &[], false).1,
            None
        );
    }

    #[test]
    fn separate_license_compliance_archive_is_not_a_player_variant() {
        let hints = ["InfiniteUndiscoveryRecomp-".into(), ".zip".into()];
        let assets = [
            asset(1, "InfiniteUndiscoveryRecomp-v1.0.0-rc1.zip"),
            asset(
                2,
                "InfiniteUndiscoveryRecomp-v1.0.0-rc1-LGPL-Compliance.zip",
            ),
        ];
        let (assessments, recommendation) =
            recommend_packages(&assets, Platform::WindowsX86_64, &hints, true);
        assert_eq!(recommendation, Some(1));
        assert_eq!(assessments[1].suitability, "auxiliary");
        assert_eq!(
            recommend_packages(&assets[1..], Platform::WindowsX86_64, &hints, true).1,
            None
        );
        assert!(!is_license_compliance_archive(
            "Compliance-game-windows-x64.zip"
        ));
        assert!(!is_license_compliance_archive("game-LGPL-windows-x64.zip"));
    }

    #[test]
    fn reviewed_win32_player_can_be_recommended_on_windows_without_accepting_foreign_processors() {
        let assets = [
            asset(1, "game-Win32-Release.zip"),
            asset(2, "game-windows-arm.zip"),
            asset(3, "game-linux-i686.zip"),
        ];
        assert_eq!(
            recommend_packages(&assets, Platform::WindowsX86_64, &[], true).1,
            None
        );
        let (assessments, recommended) = recommend_packages(
            &assets,
            Platform::WindowsX86_64,
            &["Win32-Release.zip".into()],
            true,
        );
        assert_eq!(recommended, Some(1));
        assert_eq!(assessments[1].suitability, "emulation");
        assert_eq!(assessments[2].suitability, "incompatible");
        assert_eq!(
            recommend_packages(
                &assets,
                Platform::WindowsX86_64,
                &["game".into(), ".zip".into()],
                false
            )
            .1,
            None
        );
        assert_eq!(
            recommend_packages(&assets, Platform::LinuxX86_64, &["i686.zip".into()], true).1,
            None
        );
    }

    #[test]
    fn reviewed_handoff_can_recommend_an_installer_without_running_it_or_hiding_archives() {
        let assets = [
            asset(1, "game-windows-x64.zip"),
            asset(2, "game-windows-x64-setup.exe"),
        ];
        let (options, recommendation) = recommend_packages(
            &assets,
            Platform::WindowsX86_64,
            &["-windows-x64-setup.exe".into()],
            true,
        );
        assert_eq!(recommendation, Some(2));
        assert!(
            options
                .iter()
                .all(|option| option.suitability == "suitable")
        );
        assert_eq!(
            recommend_packages(
                &assets,
                Platform::WindowsX86_64,
                &["-setup.exe".into()],
                false
            )
            .1,
            None
        );
    }

    #[test]
    fn reviewed_debug_player_does_not_make_symbols_source_or_foreign_builds_recommendable() {
        let player = asset(1, "win64-debug.zip");
        assert_eq!(
            recommend_packages(
                std::slice::from_ref(&player),
                Platform::WindowsX86_64,
                &[],
                true
            )
            .1,
            None
        );
        for generic_hints in [vec!["win64".into(), ".zip".into()], vec!["debug".into()]] {
            assert_eq!(
                recommend_packages(
                    std::slice::from_ref(&player),
                    Platform::WindowsX86_64,
                    &generic_hints,
                    true
                )
                .1,
                None
            );
        }
        assert_eq!(
            recommend_packages(
                &[player],
                Platform::WindowsX86_64,
                &["win64-debug.zip".into()],
                true
            )
            .1,
            Some(1)
        );
        for name in [
            "win64-debug-symbols.zip",
            "win64-debug-source.zip",
            "win64-debug.zip.sha256",
            "linux-x64-debug.zip",
            "windows-arm64-debug.zip",
        ] {
            assert_eq!(
                recommend_packages(
                    &[asset(1, name)],
                    Platform::WindowsX86_64,
                    &[name.into()],
                    true
                )
                .1,
                None,
                "{name}"
            );
        }
        assert_eq!(
            recommend_packages(
                &[
                    asset(1, "game-lan-windows-x64-debug.zip"),
                    asset(2, "game-steam-windows-x64-debug.zip")
                ],
                Platform::WindowsX86_64,
                &["windows-x64-debug.zip".into()],
                true
            )
            .1,
            None
        );
    }
    #[test]
    fn ambiguous_variants_unknown_platform_and_emulation_require_choice() {
        for name in [
            "game-windows-win32.zip",
            "game-windows-32bit.zip",
            "game-windows-32-bit.zip",
            "game-windows-x32.zip",
            "game-windows-armv6.zip",
        ] {
            assert_eq!(
                recommend_packages(
                    &[asset(1, name)],
                    Platform::WindowsX86_64,
                    &["windows".into()],
                    true
                )
                .1,
                None,
                "{name}"
            );
        }
        assert_eq!(
            recommend_packages(
                &[
                    asset(1, "game-windows-x64.zip"),
                    asset(2, "game-hd-windows-x64.zip")
                ],
                Platform::WindowsX86_64,
                &[],
                true
            )
            .1,
            None
        );
        assert_eq!(
            recommend_packages(&[asset(1, "game.zip")], Platform::WindowsX86_64, &[], true).1,
            None
        );
        assert_eq!(
            recommend_packages(
                &[asset(1, "game-macos-x64.zip")],
                Platform::MacosAarch64,
                &[],
                true
            )
            .0[0]
                .suitability,
            "emulation"
        );
        assert_eq!(
            recommend_packages(
                &[asset(1, "game-macos-universal.zip")],
                Platform::MacosAarch64,
                &[],
                true
            )
            .1,
            Some(1)
        );
    }
}
