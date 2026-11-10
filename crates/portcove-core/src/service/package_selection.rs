//! Suitability only: acquisition still refreshes immutable IDs and integrity policy.
use super::*;

const ARCHIVE_FORMS: &[&str] = &[".zip", ".7z", ".tar.gz", ".tar.xz", ".tgz", ".rar"];
const OTHER_PACKAGE_FORMS: &[&str] = &[
    ".exe",
    ".msi",
    ".appimage",
    ".dmg",
    ".pkg",
    ".deb",
    ".rpm",
    ".7z",
    ".tar.xz",
];

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum PackagePlatformMatch {
    Matching,
    Other,
    Unspecified,
    Ambiguous,
}

pub(crate) fn is_package_filename(name: &str) -> bool {
    ARCHIVE_FORMS
        .iter()
        .chain(OTHER_PACKAGE_FORMS)
        .any(|extension| name.ends_with(extension))
}

pub(crate) fn package_platform_match(name: &str, platform: Platform) -> PackagePlatformMatch {
    let name = name.to_ascii_lowercase();
    let tokens = name
        .split(|c: char| !c.is_ascii_alphanumeric())
        .collect::<Vec<_>>();
    let has = |values: &[&str]| values.iter().any(|value| tokens.contains(value));
    let windows = has(&["windows", "win", "win32", "win64", "winx64"])
        || name.ends_with(".exe")
        || name.ends_with(".msi");
    let linux = has(&["linux", "appimage", "flatpak"])
        || [".appimage", ".deb", ".rpm"]
            .iter()
            .any(|ext| name.ends_with(ext));
    let versioned_macos = tokens.iter().any(|token| {
        token
            .strip_prefix("macos")
            .is_some_and(|major| major.len() == 2 && major.parse::<u8>().is_ok_and(|v| v >= 10))
    });
    let mac = has(&["mac", "macos", "osx", "darwin"])
        || versioned_macos
        || name.ends_with(".dmg")
        || name.ends_with(".pkg");
    let foreign = has(&["android", "switch", "vita", "wii", "ios"]) || name.ends_with(".apk");
    match [windows, linux, mac, foreign]
        .into_iter()
        .filter(|named| *named)
        .count()
    {
        0 => PackagePlatformMatch::Unspecified,
        1 => {
            let matches = match platform {
                Platform::WindowsX86_64 => windows,
                Platform::LinuxX86_64 => linux,
                Platform::MacosX86_64 | Platform::MacosAarch64 => mac,
            };
            if matches {
                PackagePlatformMatch::Matching
            } else {
                PackagePlatformMatch::Other
            }
        }
        _ => PackagePlatformMatch::Ambiguous,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CatalogDownloadRelease {
    pub id: CatalogDownloadReleaseId,
    pub tag: String,
    pub preview: bool,
    pub assets_complete: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CatalogPackageAssessment {
    pub asset_id: CatalogDownloadAssetId,
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
            asset_id: asset.asset_id.clone(),
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
    let archive = ARCHIVE_FORMS.iter().any(|ext| name.ends_with(ext));
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
            ".dsc",
            ".orig.tar.gz",
            ".orig.tar.xz",
            ".debian.tar.xz",
            ".diff.gz",
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
    let named_platform = package_platform_match(&name, platform);
    let platform_match = named_platform == PackagePlatformMatch::Matching;
    if matches!(
        named_platform,
        PackagePlatformMatch::Other | PackagePlatformMatch::Ambiguous
    ) {
        return finish(
            "incompatible",
            "Named for another platform. Portcove does not offer a compatibility-layer launch route.",
            None,
        );
    }
    // Native macOS packages may use "arm" for Apple Silicon. On other
    // platforms the same token still describes an unspecified older ARM ABI.
    let macos_arm = platform_match
        && matches!(platform, Platform::MacosAarch64 | Platform::MacosX86_64)
        && has(&["arm"]);
    let arm = has(&["arm64", "aarch64"]) || macos_arm;
    let intel = has(&["x64", "amd64", "win64", "winx64", "intel"])
        || name.contains("x86_64")
        || name.contains("x86-64");
    let legacy = has(&[
        "i386", "i686", "win32", "x32", "32bit", "armv6", "armv7", "armv8",
    ]) || name.contains("32-bit")
        || name.contains("32_bit")
        || (has(&["arm"]) && !macos_arm)
        || (has(&["x86"]) && !intel);
    let universal = has(&["universal", "universal2"]) || (arm && intel);
    let wants_arm = platform == Platform::MacosAarch64;
    let reviewed_windows_x86 = hinted
        && platform == Platform::WindowsX86_64
        && platform_match
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
    let supported_form = can_extract || OTHER_PACKAGE_FORMS.iter().any(|ext| name.ends_with(ext));
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
) -> (
    Vec<CatalogPackageAssessment>,
    Option<CatalogDownloadAssetId>,
) {
    let assessed = assets
        .iter()
        .map(|asset| assess_package(asset, platform, hints))
        .collect::<Vec<_>>();
    let mut ranked = assessed
        .iter()
        .filter_map(|(assessment, score)| score.map(|score| (score, assessment.asset_id.clone())))
        .collect::<Vec<_>>();
    ranked.sort_by_key(|item| std::cmp::Reverse(item.0));
    let recommended = if complete
        && ranked
            .first()
            .is_some_and(|best| ranked.get(1).is_none_or(|next| best.0 > next.0))
    {
        ranked.first().map(|best| best.1.clone())
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
            release_id: 1.into(),
            asset_id: id.into(),
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
        assert_eq!(recommendation, Some(1.into()));
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
    fn n64_picker_listings_recommend_the_observed_desktop_archives() {
        let catalog = crate::Catalog::embedded().unwrap();
        let cases = [
            (
                "snprecomp-wootbeer-sin-and-punishment",
                "SnPRecompiled-0.2.10-windows.zip",
                "SnPRecompiled-0.2.10-linux-x86_64.tar.gz",
                "SnPRecompiled-0.2.10-android.apk",
            ),
            (
                "jetforcegemini-recomp-vibintoast-jet-force-gemini",
                "JFG-1.3.2-windows-x64-portable.zip",
                "JFG-1.3.2-linux-x86_64-portable.tar.gz",
                "JFG-1.3.2-linux-x86_64.AppImage",
            ),
            (
                "iss2000-djultra64-international-superstar-soccer-2000",
                "ISS2000-Windows-0.7.1.zip",
                "ISS2000-Linux-0.7.1.zip",
                "SHA256SUMS-0.7.1.txt",
            ),
        ];
        for (id, windows, linux, other) in cases {
            let listing = catalog.listing(id).unwrap();
            let mut assets = [asset(1, windows), asset(2, linux), asset(3, other)];
            assets[1].can_extract = true;
            for (platform, expected) in
                [(Platform::WindowsX86_64, 1u64), (Platform::LinuxX86_64, 2)]
            {
                let hints = &listing.download_asset_hints[&platform];
                assert_eq!(
                    recommend_packages(&assets, platform, hints, true).1,
                    Some(expected.into()),
                    "{id} on {platform:?}"
                );
            }
        }
    }

    #[test]
    fn classic_engine_releases_recommend_the_observed_host_packages() {
        let catalog = crate::Catalog::embedded().unwrap();
        let vcmi = [
            asset(1, "VCMI-Windows.zip"),
            asset(2, "VCMI-Linux-x64.AppImage"),
            asset(3, "VCMI-Linux-arm64.AppImage"),
            asset(4, "VCMI-macOS-intel.dmg"),
            asset(5, "VCMI-macOS-arm.dmg"),
        ];
        let trx = [
            asset(1, "TRX-1.12-Windows_Installer.exe"),
            asset(2, "TRX-1.12-Linux.zip"),
            asset(3, "TRX-1.12-Mac.dmg"),
            asset(4, "TRX-1.12-Windows.zip"),
        ];
        for (platform, vcmi_id, trx_id) in [
            (Platform::WindowsX86_64, 1u64, 1u64),
            (Platform::LinuxX86_64, 2, 2),
            (Platform::MacosX86_64, 4, 3),
            (Platform::MacosAarch64, 5, 3),
        ] {
            for (id, assets, expected) in [
                ("vcmi-vcmi", vcmi.as_slice(), vcmi_id),
                ("lostartefacts-trx", trx.as_slice(), trx_id),
            ] {
                let hints = &catalog.listing(id).unwrap().download_asset_hints[&platform];
                assert_eq!(
                    recommend_packages(assets, platform, hints, true).1,
                    Some(expected.into()),
                    "{id} on {platform:?}"
                );
            }
        }
    }

    #[test]
    fn classic_engine_sibling_guides_select_packages_across_releases() {
        let catalog = crate::Catalog::embedded().unwrap();
        let openmw_releases = [
            [
                "openmw-0.50.0-Linux-64Bit.tar.gz",
                "OpenMW-0.50.0-macos-amd64.dmg",
                "OpenMW-0.50.0-macos-arm64.dmg",
                "openmw-0.50.0-Linux-64Bit-debug.tar.gz",
            ],
            [
                "openmw-0.51.0-Linux-64Bit.tar.gz",
                "OpenMW-0.51.0-macOS-x86_64.dmg",
                "OpenMW-0.51.0-macOS-arm64.dmg",
                "openmw-0.51.0-Linux-64Bit-debug.tar.gz",
            ],
        ];
        let openmw = catalog
            .listing("the-elder-scrolls-iii-morrowind-openmw")
            .unwrap();
        for [linux, intel, arm, debug] in openmw_releases {
            let mut assets = [
                asset(1, linux),
                asset(2, intel),
                asset(3, arm),
                asset(4, debug),
            ];
            assets[0].can_extract = true;
            assets[3].can_extract = true;
            for (platform, expected) in [
                (Platform::LinuxX86_64, 1u64),
                (Platform::MacosX86_64, 2),
                (Platform::MacosAarch64, 3),
            ] {
                let hints = &openmw.download_asset_hints[&platform];
                assert_eq!(
                    recommend_packages(&assets, platform, hints, true).1,
                    Some(expected.into())
                );
            }
        }
        let openrct2 = catalog.listing("openrct2-openrct2").unwrap();
        let vkquake = catalog.listing("quake-vkquake").unwrap();
        for names in [
            [
                "OpenRCT2-v0.5.6-macos-universal.zip",
                "OpenRCT2-v0.5.6-android.apk",
            ],
            [
                "OpenRCT2-v0.5.7-macos-universal.zip",
                "OpenRCT2-v0.5.7-android.apk",
            ],
        ] {
            let assets = [asset(1, names[0]), asset(2, names[1])];
            for platform in [Platform::MacosX86_64, Platform::MacosAarch64] {
                let hints = &openrct2.download_asset_hints[&platform];
                assert_eq!(
                    recommend_packages(&assets, platform, hints, true).1,
                    Some(1.into())
                );
            }
        }
        let platform = Platform::LinuxX86_64;
        for names in [
            [
                "vkQuake-1.36.0-x86_64.AppImage",
                "vkQuake-1.36.0_windows_arm64.zip",
            ],
            [
                "vkQuake-1.37.0-x86_64.AppImage",
                "vkQuake-1.37.0_windows_arm64.zip",
            ],
        ] {
            let assets = [asset(1, names[0]), asset(2, names[1])];
            let hints = &vkquake.download_asset_hints[&platform];
            assert_eq!(
                recommend_packages(&assets, platform, hints, true).1,
                Some(1.into())
            );
        }
    }

    #[test]
    fn classic_data_guides_select_native_packages_without_choosing_an_openra_game() {
        let catalog = crate::Catalog::embedded().unwrap();
        let cases = [
            (
                "corsixth-corsixth",
                Some(2u64),
                [
                    asset(1, "CorsixTH-v0.70.1-x86_64.AppImage"),
                    asset(2, "CorsixTH-0.70.1.dmg"),
                    asset(3, "CorsixTH-v0.70.1-Windows-x64.zip"),
                ],
            ),
            (
                "openloco-openloco",
                None,
                [
                    asset(1, "OpenLoco-v26.09-linux-x64.AppImage"),
                    asset(2, "OpenLoco-v26.09-macos-arm64.zip"),
                    asset(3, "OpenLoco-v26.09-windows-portable-x64.zip"),
                ],
            ),
        ];
        for (id, expected_intel, assets) in cases {
            let listing = catalog.listing(id).unwrap();
            for (platform, expected) in [(Platform::LinuxX86_64, 1u64), (Platform::MacosAarch64, 2)]
            {
                let hints = &listing.download_asset_hints[&platform];
                assert_eq!(
                    recommend_packages(&assets, platform, hints, true).1,
                    Some(expected.into()),
                    "{id}"
                );
            }
            let intel = listing.download_asset_hints.get(&Platform::MacosX86_64);
            assert_eq!(
                recommend_packages(
                    &assets,
                    Platform::MacosX86_64,
                    intel.map(Vec::as_slice).unwrap_or_default(),
                    true
                )
                .1,
                expected_intel.map(Into::into),
                "{id} on Intel Mac"
            );
        }

        let mut devilution_assets = [
            asset(1, "devilutionx-linux-x86_64.appimage"),
            asset(2, "devilutionx-macOS-universal.dmg"),
            asset(3, "devilutionx-macOS-intel-x86.dmg"),
            asset(4, "devilutionx-android.apk"),
            asset(5, "devilutionx-linux-x86_64.tar.xz"),
        ];
        devilution_assets[4].can_extract = true;
        for id in ["diablo-devilutionx", "diablo-hellfire-devilutionx"] {
            let listing = catalog.listing(id).unwrap();
            for (platform, expected) in [
                (Platform::LinuxX86_64, 1u64),
                (Platform::MacosX86_64, 2),
                (Platform::MacosAarch64, 2),
            ] {
                assert_eq!(
                    recommend_packages(
                        &devilution_assets,
                        platform,
                        &listing.download_asset_hints[&platform],
                        true
                    )
                    .1,
                    Some(expected.into()),
                    "{id} on {platform:?}"
                );
            }
        }

        let openra = catalog.listing("openra-openra").unwrap();
        let assets = [
            asset(1, "OpenRA-Red-Alert-x86_64.AppImage"),
            asset(2, "OpenRA-Tiberian-Dawn-x86_64.AppImage"),
            asset(3, "OpenRA-Dune-2000-x86_64.AppImage"),
            asset(4, "OpenRA-release-20250330.dmg"),
        ];
        let linux = openra.download_asset_hints.get(&Platform::LinuxX86_64);
        let (packages, recommended) = recommend_packages(
            &assets,
            Platform::LinuxX86_64,
            linux.map(Vec::as_slice).unwrap_or_default(),
            true,
        );
        assert_eq!(recommended, None);
        assert_eq!(
            packages
                .iter()
                .filter(|package| package.suitability == "suitable")
                .count(),
            3
        );
        for platform in [Platform::MacosX86_64, Platform::MacosAarch64] {
            assert_eq!(
                recommend_packages(
                    &assets,
                    platform,
                    &openra.download_asset_hints[&platform],
                    true
                )
                .1,
                Some(4.into())
            );
        }
    }

    #[test]
    fn macos_arm_shorthand_selects_apple_silicon_and_keeps_older_arm_distinct() {
        let catalog = crate::Catalog::embedded().unwrap();
        let mut assets = [
            asset(1, "opengoal-macos-arm-v0.3.9.tar.gz"),
            asset(2, "opengoal-macos-intel-v0.3.9.tar.gz"),
            asset(3, "opengoal-lsp-macos-arm-v0.3.9.bin"),
        ];
        assets[0].can_extract = true;
        assets[1].can_extract = true;
        for id in ["opengoal-jak1", "opengoal-jak2", "opengoal-jak3"] {
            let port = catalog.port(id).unwrap();
            for (platform, expected) in [(Platform::MacosAarch64, 1u64), (Platform::MacosX86_64, 2)]
            {
                let hints = &port.release.asset_hints[&platform];
                assert_eq!(
                    recommend_packages(&assets, platform, hints, true).1,
                    Some(expected.into()),
                    "{id} on {platform:?}"
                );
            }
        }
        for (platform, name) in [
            (Platform::MacosAarch64, "game-macos-armv7.zip"),
            (Platform::LinuxX86_64, "game-linux-arm.tar.gz"),
        ] {
            assert_eq!(
                assess_package_name(name, true, platform, &[]).0,
                "emulation"
            );
        }
    }

    #[test]
    fn versioned_macos_names_recommend_the_openomf_apple_silicon_package() {
        let catalog = crate::Catalog::embedded().unwrap();
        let listing = catalog.listing("omf2097-openomf").unwrap();
        let hints = &listing.download_asset_hints[&Platform::MacosAarch64];
        for name in [
            "openomf_0.8.6_macos14_arm.zip",
            "openomf_0.8.7-131-bc3eca03_macos15_arm.zip",
        ] {
            let assets = [asset(1, name), asset(2, "openomf_0.8.6_windows.zip")];
            assert_eq!(
                recommend_packages(&assets, Platform::MacosAarch64, hints, true).1,
                Some(1.into()),
                "{name}"
            );
            assert_eq!(
                assess_package_name(name, true, Platform::MacosX86_64, hints).0,
                "incompatible"
            );
            assert_eq!(
                package_platform_match(name, Platform::LinuxX86_64),
                PackagePlatformMatch::Other
            );
        }
        assert_eq!(
            package_platform_match("game-macos14beta-arm.zip", Platform::MacosAarch64),
            PackagePlatformMatch::Unspecified
        );
        assert_eq!(
            package_platform_match("game-macos14-linux-arm.zip", Platform::MacosAarch64),
            PackagePlatformMatch::Ambiguous
        );
    }

    #[test]
    fn catacomb_linux_preview_is_a_download_for_user_prepared_play() {
        let catalog = crate::Catalog::embedded().unwrap();
        let assets = [
            asset(1, "CatacombGL-Windows-64bit-0-5-7.zip"),
            asset(2, "CatacombGL-Windows-32bit-0-5-7.zip"),
            asset(3, "CatacombGL-Linux-0-5-7.tar.xz"),
        ];
        let platform = Platform::LinuxX86_64;
        for id in [
            "catacomb-3-d-the-descent-catacombgl",
            "the-catacomb-abyss-catacombgl",
            "the-catacomb-armageddon-catacombgl",
            "the-catacomb-apocalypse-catacombgl",
        ] {
            let port = catalog.port(id).unwrap();
            assert_eq!(port.release.provider, crate::ReleaseSource::UserPrepared);
            assert_eq!(
                port.release.user_prepared[&platform].trust,
                crate::ExternalRuntimeTrust::UserSelected,
                "{id}"
            );
            let listing = catalog.listing(id).unwrap();
            assert_eq!(
                listing.recommended_download_channel,
                Some(crate::ReleaseChannel::Beta)
            );
            assert_eq!(
                recommend_packages(
                    &assets,
                    platform,
                    &listing.download_asset_hints[&platform],
                    true
                )
                .1,
                Some(3.into()),
                "{id}"
            );
        }
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
        assert_eq!(recommendation, Some(1.into()));
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
        assert_eq!(recommended, Some(1.into()));
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
        assert_eq!(recommendation, Some(2.into()));
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
            Some(1.into())
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
            Some(1.into())
        );
    }
}
