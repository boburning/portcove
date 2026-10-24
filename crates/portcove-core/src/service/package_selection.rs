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
        "debug",
    ]) || [
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
    if legacy && !universal {
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
    let hinted = !hints.is_empty()
        && hints
            .iter()
            .all(|hint| name.contains(&hint.to_ascii_lowercase()));
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
    ranked.sort_by(|a, b| b.0.cmp(&a.0));
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
    fn ambiguous_variants_unknown_platform_and_emulation_require_choice() {
        for name in [
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
