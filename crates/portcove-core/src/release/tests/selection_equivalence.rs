//! Selection equivalence for typed artifact roles (#8555).
//!
//! Every embedded GitHub port, each supported platform and each channel is
//! replayed over every recorded release fixture in `src/testdata`. A frozen
//! copy of the selection logic from before typed roles (verbatim from `main`
//! at d27d2fbb3, renamed with a `legacy_` prefix) is compared with the typed
//! path. Differences are allowed only for the two named defects and every one
//! is listed below with its reason.

use std::collections::BTreeSet;

use super::*;
use crate::service::package_selection::PackagePlatformMatch;

// ---- Frozen pre-typed selection logic. Do not edit. ----

const LEGACY_ARCHIVE_FORMS: &[&str] = &[".zip", ".7z", ".tar.gz", ".tar.xz", ".tgz", ".rar"];
const LEGACY_OTHER_PACKAGE_FORMS: &[&str] = &[
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

fn legacy_is_package_filename(name: &str) -> bool {
    LEGACY_ARCHIVE_FORMS
        .iter()
        .chain(LEGACY_OTHER_PACKAGE_FORMS)
        .any(|extension| name.ends_with(extension))
}

fn legacy_package_platform_match(name: &str, platform: Platform) -> PackagePlatformMatch {
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
    // PortMaster packages target handheld Linux firmware, not desktop systems.
    let foreign =
        has(&["android", "switch", "vita", "wii", "ios", "portmaster"]) || name.ends_with(".apk");
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

fn legacy_assess_package_name(
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
    let exact_hint = hinted && hints.iter().any(|hint| hint.eq_ignore_ascii_case(&name));
    // Generic managed/platform hints must not turn a debug build into the
    // recommended release. A reviewed debug player needs its whole filename.
    let finish = |suitability, reason, score| (suitability, reason, score);
    let archive = LEGACY_ARCHIVE_FORMS.iter().any(|ext| name.ends_with(ext));
    if crate::service::package_selection::is_server_package(&name) {
        return finish(
            "auxiliary",
            "This package is labeled as a dedicated server. Choose a game client to play.",
            None,
        );
    }
    if has(&[
        "checksums",
        "checksum",
        "sha256sums",
        "sha512sums",
        "symbols",
        "pdb",
        "dsym",
    ]) || (!exact_hint && has(&["debug"]))
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
        || crate::service::package_selection::is_license_compliance_archive(&name)
    {
        return finish(
            "auxiliary",
            "Checksums, signatures, source code or supporting metadata; not an installable game package.",
            None,
        );
    }
    if !hints.is_empty() && !hinted && has(&["server"]) {
        return finish(
            "auxiliary",
            "Server download; the catalog's player package hints refer to a different asset.",
            None,
        );
    }
    let named_platform = legacy_package_platform_match(&name, platform);
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
    // Periods in a versioned filename do not imply a file extension. Accept
    // the Linux platform suffix when the final period belongs to its version.
    let bare_name = name.rsplit_once('.').is_none_or(|(_, suffix)| {
        suffix.as_bytes().first().is_some_and(u8::is_ascii_digit)
            && (suffix.ends_with("-linux-x64") || suffix.ends_with("-linux-x86_64"))
    });
    let reviewed_bare_linux_player =
        exact_hint && platform_match && platform == Platform::LinuxX86_64 && bare_name;
    let supported_form = can_extract
        || reviewed_bare_linux_player
        || LEGACY_OTHER_PACKAGE_FORMS
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

fn legacy_native_release_applies_to_platform(
    port: &PortDefinition,
    platform: Platform,
    release: &GithubRelease,
) -> bool {
    if !github_tag_in_stream(port, platform, &release.tag_name) {
        return false;
    }
    if (port.adapter != AdapterKind::NativePortable && port.archive_data_compatibility_v1.is_none())
        || port.release.curated.contains_key(&platform)
    {
        return true;
    }
    let mut other_platform_player = false;
    for asset in &release.assets {
        let name = asset.name.to_ascii_lowercase();
        let can_extract = [".zip", ".tar.gz", ".tgz"]
            .iter()
            .any(|ext| name.ends_with(ext));
        let (suitability, _, _) = legacy_assess_package_name(&name, can_extract, platform, &[]);
        if suitability == "auxiliary" {
            if name
                .split(|character: char| !character.is_ascii_alphanumeric())
                .any(|token| token == "debug")
            {
                return true;
            }
            continue;
        }
        if legacy_package_platform_match(&name, platform) != PackagePlatformMatch::Other {
            return true;
        }
        other_platform_player |= legacy_is_package_filename(&name);
    }
    // Only explicit other-OS players are outside this platform's release stream.
    // Same/unknown OS and source-only releases retain normal refusal semantics.
    !other_platform_player
}

fn legacy_choose_asset_for_variant<'a>(
    port: &PortDefinition,
    platform: Platform,
    assets: &'a [GithubAsset],
    saved: Option<(&ManagedPackageVariant, &str)>,
) -> Result<&'a GithubAsset> {
    let explicit = saved.filter(|(variant, _)| variant.explicit_id().is_some());
    if let Some((variant, tag)) = explicit {
        let mut matches = assets
            .iter()
            .filter(|asset| variant.names_explicit_family(&asset.name));
        let first = matches.next().ok_or_else(|| {
            PortcoveError::conflict(
                "the current release has no verified package matching the saved choice",
            )
            .detail("saved_package_variant", "no-matching-package")
        })?;
        if matches.next().is_some() {
            return Err(PortcoveError::conflict(
                "the current release has more than one package matching the saved choice",
            )
            .detail("saved_package_variant", "ambiguous"));
        }
        if !variant.matches(tag, &first.name) {
            return Err(PortcoveError::verification(
                "the selected package filename differs from its exact release tag",
            ));
        }
    }
    let requires_tar_xz = port.release.requires_tar_xz(platform);
    let standalone = native_appimage(port, platform);
    let hints = if let Some((variant, _)) = explicit {
        // The named, checked family replaces the default package preference;
        // portable suitability, package format and profile restrictions still apply.
        vec![variant.explicit_archive_hint().to_owned()]
    } else {
        port.release
            .asset_hints
            .get(&platform)
            .cloned()
            .unwrap_or_default()
    };
    let mut scored: Vec<(i32, &GithubAsset)> = assets
        .iter()
        .filter_map(|asset| {
            if saved.is_some_and(|(variant, tag)| !variant.matches(tag, &asset.name)) {
                return None;
            }
            let name = asset.name.to_ascii_lowercase();
            if !crate::native_external_profile::openmohaa::matches_asset(port, platform, &name)
                || !crate::native_external_profile::openjk::matches_asset(
                    port,
                    platform,
                    &asset.name,
                )
                || !crate::native_external_profile::quake_linux::matches_ironwail_tar(
                    port, platform, &name,
                )
                || !crate::native_external_profile::profile_siblings::matches_openloco_zip(
                    port, platform, &name,
                )
                || !crate::native_external_profile::archive_siblings::matches_asset(
                    port, platform, &name,
                )
                || !crate::native_portable_data::matches_archive(port, platform, &name)
                || !crate::native_external_profile::vcmi::matches_asset(port, platform, &name)
                || !crate::native_external_profile::endless_sky::matches_asset(
                    port, platform, &name,
                )
            {
                return None;
            }
            let supported_package = if let Some(expected) = &standalone {
                expected.matches(&name)
            } else if requires_tar_xz {
                name.ends_with(".tar.xz")
            } else {
                is_supported_package(&name)
            };
            if is_checksum_name(&name) || is_auxiliary_package(&name) || !supported_package {
                return None;
            }
            let can_extract = requires_tar_xz
                || [".zip", ".tar.gz", ".tgz"]
                    .iter()
                    .any(|extension| name.ends_with(extension));
            if (port.adapter == AdapterKind::NativePortable
                || port.n64_runtime_at_executable_parent)
                && !can_extract
                && standalone.is_none()
            {
                return None;
            }
            if matches!(
                port.adapter,
                AdapterKind::NativePortable | AdapterKind::StagedSourcePortable
            ) || port.n64_runtime_at_executable_parent
            {
                // Reusable portable rules and the download recommendation share
                // native suitability. A selected variant cannot become optional
                // when a successor publishes only another package class.
                if !hints
                    .iter()
                    .all(|hint| name.contains(&hint.to_ascii_lowercase()))
                {
                    return None;
                }
                let (_, _, score) =
                    legacy_assess_package_name(&name, can_extract, platform, &hints);
                return score.map(|score| (score as i32, asset));
            }
            if conflicts_with_platform(&name, platform) {
                return None;
            }
            if (port.adapter == AdapterKind::PsxRecompManaged
                || port.release.tar_xz_platforms.contains(&platform))
                && !hints
                    .iter()
                    .all(|hint| name.contains(&hint.to_ascii_lowercase()))
            {
                // Preparation-kit and declared TAR.XZ package choices stay mandatory.
                // PSX kits retain their own supported archive contract; source
                // preparation is not a native-player package disqualifier.
                return None;
            }
            let platform_score = platform
                .asset_tokens()
                .iter()
                .filter(|token| name.contains(**token))
                .count() as i32
                * 10;
            let hint_score = hints
                .iter()
                .filter(|hint| name.contains(&hint.to_ascii_lowercase()))
                .count() as i32
                * 100;
            let archive_score = if name.ends_with(".zip") || name.ends_with(".tar.gz") {
                3
            } else {
                1
            };
            Some((hint_score + platform_score + archive_score, asset))
        })
        .collect();
    scored.sort_by(|left, right| {
        right
            .0
            .cmp(&left.0)
            .then_with(|| left.1.name.cmp(&right.1.name))
    });
    let Some((best_score, best_asset)) = scored.first() else {
        if saved.is_some() {
            return Err(PortcoveError::conflict(
                "the current release has no verified package matching the saved choice",
            )
            .detail("saved_package_variant", "no-matching-package"));
        }
        return Err(PortcoveError::not_found(format!(
            "{} has no supported release asset for {platform:?}",
            port.name
        )));
    };
    if saved.is_some() && scored.len() > 1 {
        return Err(PortcoveError::conflict(
            "the current release has more than one package matching the saved choice",
        )
        .detail("saved_package_variant", "ambiguous"));
    }
    if scored.get(1).is_some_and(|(score, _)| score == best_score) {
        return Err(PortcoveError::conflict(format!(
            "{} publishes multiple equally qualified release assets for {platform:?}; catalog metadata must select exactly one",
            port.name
        )));
    }
    Ok(*best_asset)
}

// ---- Harness. ----

fn legacy_choose_asset<'a>(
    port: &PortDefinition,
    platform: Platform,
    assets: &'a [GithubAsset],
) -> Result<&'a GithubAsset> {
    legacy_choose_asset_for_variant(port, platform, assets, None)
}

fn release_like(value: &serde_json::Value) -> bool {
    value["tag_name"].is_string()
        && value["assets"]
            .as_array()
            .is_some_and(|assets| assets.iter().all(|asset| asset["name"].is_string()))
}

fn normalized(mut value: serde_json::Value) -> GithubRelease {
    for (key, default) in [("draft", false), ("prerelease", false)] {
        if !value[key].is_boolean() {
            value[key] = serde_json::json!(default);
        }
    }
    let tag = value["tag_name"].as_str().unwrap().to_owned();
    for asset in value["assets"].as_array_mut().unwrap() {
        if !asset["browser_download_url"].is_string() {
            asset["browser_download_url"] = serde_json::json!(format!(
                "https://github.com/fixture/fixture/releases/download/{tag}/{}",
                asset["name"].as_str().unwrap()
            ));
        }
        if !asset["size"].is_u64() {
            asset["size"] = serde_json::json!(1);
        }
        if !asset["digest"].is_string() {
            asset["digest"] = serde_json::Value::Null;
        }
    }
    serde_json::from_value(value).unwrap()
}

fn collect_lists(value: &serde_json::Value, out: &mut Vec<Vec<GithubRelease>>) {
    match value {
        serde_json::Value::Array(items) if !items.is_empty() && items.iter().all(release_like) => {
            out.push(items.iter().cloned().map(normalized).collect());
        }
        serde_json::Value::Array(items) => items.iter().for_each(|item| collect_lists(item, out)),
        serde_json::Value::Object(_) if release_like(value) => {
            out.push(vec![normalized(value.clone())]);
        }
        serde_json::Value::Object(map) => {
            for (key, item) in map {
                if let Some(prefix) = key.strip_suffix("asset_names")
                    && let Some(names) = item.as_array()
                    && names.iter().all(serde_json::Value::is_string)
                {
                    let tag = map
                        .get(&format!("{prefix}tag"))
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("fixture-synthetic");
                    out.push(vec![normalized(serde_json::json!({
                        "tag_name": tag,
                        "published_at": null,
                        "assets": names.iter().map(|name| serde_json::json!({"name": name})).collect::<Vec<_>>(),
                    }))]);
                } else {
                    collect_lists(item, out);
                }
            }
        }
        _ => {}
    }
}

fn fixture_release_lists() -> Vec<(String, Vec<GithubRelease>)> {
    let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/testdata");
    let mut files = std::fs::read_dir(&directory)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .collect::<Vec<_>>();
    files.sort();
    let mut lists = Vec::new();
    for file in files {
        let value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        let mut found = Vec::new();
        collect_lists(&value, &mut found);
        let name = file.file_name().unwrap().to_string_lossy().into_owned();
        lists.extend(found.into_iter().map(|list| (name.clone(), list)));
    }
    lists
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Defect {
    /// Judged by the frozen legacy token rules: the legacy candidate's
    /// non-supporting assets all name another platform, legacy selection
    /// found no package or chose another host's package or a supporting file,
    /// and an older release now becomes the candidate.
    ForeignOnlyReleaseHidesOlderRelease,
    /// Legacy selection chose a package the frozen token rules name for
    /// another host, or tied with one: removing those packages yields the
    /// typed choice.
    WrongHostPackage,
}

/// The fixture records this port's own repository.
fn own_fixture(port: &PortDefinition, list: &[GithubRelease]) -> bool {
    let prefix = format!(
        "https://github.com/{}/",
        port.release.repository.to_ascii_lowercase()
    );
    list.iter().any(|release| {
        release.assets.iter().any(|asset| {
            asset
                .browser_download_url
                .to_ascii_lowercase()
                .starts_with(&prefix)
        })
    })
}

/// Frozen legacy token rules for "names another platform".
fn legacy_other_host(name: &str, platform: Platform) -> bool {
    legacy_package_platform_match(&name.to_ascii_lowercase(), platform)
        == PackagePlatformMatch::Other
}

fn legacy_supporting(name: &str, platform: Platform) -> bool {
    let name = name.to_ascii_lowercase();
    let can_extract = [".zip", ".tar.gz", ".tgz"]
        .iter()
        .any(|extension| name.ends_with(extension));
    legacy_assess_package_name(&name, can_extract, platform, &[]).0 == "auxiliary"
}

/// Every non-supporting asset names another platform by the frozen legacy
/// token rules, and at least one does.
fn legacy_foreign_only(release: &GithubRelease, platform: Platform) -> bool {
    let mut foreign = false;
    for asset in &release.assets {
        let name = asset.name.to_ascii_lowercase();
        if legacy_supporting(&name, platform) {
            if name
                .split(|character: char| !character.is_ascii_alphanumeric())
                .any(|token| token == "debug")
            {
                return false;
            }
            continue;
        }
        if !legacy_other_host(&name, platform) {
            return false;
        }
        foreign = true;
    }
    foreign
}

/// Exceptions keyed by port, platform, fixture, release, channel (`asset` for
/// a single-release asset selection) and defect. Each one is a cross-applied
/// replay: no fixture here belongs to the port it changes.
const EXCEPTIONS_PATH: &str = "src/release/tests/selection_equivalence_exceptions.txt";

/// Ports per adapter with at least one release fixture from their own
/// repository. Adapters absent here have no own-fixture coverage.
/// Uncovered: `referenced-disc` (0 of 1 ports) and `upstream-managed-setup`
/// (0 of 4). Their release facts are not recorded in any fixture, and a
/// fixture built from authored selectors would invent upstream facts.
const OWN_FIXTURE_COVERAGE: &[(&str, usize)] = &[
    ("generated-cache", 2),
    ("libultraship-portable", 2),
    ("n64-recomp-portable", 3),
    ("native-portable", 49),
    ("psx-recomp-managed", 71),
    ("staged-source-portable", 7),
];

#[test]
fn typed_selection_matches_legacy_selection_except_named_defects() {
    let catalog = crate::Catalog::embedded().unwrap();
    let lists = fixture_release_lists();
    assert!(
        lists.len() >= 100,
        "fixture inventory shrank: {}",
        lists.len()
    );
    let mut exceptions = BTreeSet::new();
    let mut unexplained = Vec::new();
    let mut own_exceptions = Vec::new();
    let (mut assets_compared, mut candidates_compared) = (0usize, 0usize);
    let mut own_pairs = BTreeSet::new();
    let mut adapters = std::collections::BTreeMap::<String, (BTreeSet<&str>, usize)>::new();
    for port in catalog
        .ports()
        .iter()
        .filter(|port| port.release.provider == crate::ReleaseSource::Github)
    {
        let adapter = serde_json::to_value(port.adapter)
            .unwrap()
            .as_str()
            .unwrap()
            .to_owned();
        adapters.entry(adapter.clone()).or_default().1 += 1;
        for &platform in &port.platforms {
            let mut seen = BTreeSet::new();
            for (fixture, list) in &lists {
                let own = own_fixture(port, list);
                if own {
                    own_pairs.insert((port.id.as_str(), fixture.as_str()));
                    adapters
                        .get_mut(&adapter)
                        .unwrap()
                        .0
                        .insert(port.id.as_str());
                }
                let mut record =
                    |tag: &str, channel: String, defect: Option<Defect>, detail: String| {
                        let row = format!("{} {platform:?} {fixture} {tag} {channel}", port.id);
                        match defect {
                            Some(_) if own => own_exceptions.push(format!("{row} {detail}")),
                            Some(defect) => {
                                exceptions.insert(format!("{row} {defect:?}"));
                            }
                            None => unexplained.push(format!("{row} {detail}")),
                        }
                    };
                for release in list {
                    if !seen.insert((fixture.as_str(), release.tag_name.as_str())) {
                        continue;
                    }
                    assets_compared += 1;
                    let old = legacy_choose_asset(port, platform, &release.assets);
                    let new = choose_asset(port, platform, &release.assets)
                        .ok()
                        .map(|asset| asset.name.as_str());
                    let old_name = old.as_ref().ok().map(|asset| asset.name.as_str());
                    if old_name == new {
                        continue;
                    }
                    let wrong_host_choice =
                        old_name.is_some_and(|name| legacy_other_host(name, platform));
                    let host_assets = release
                        .assets
                        .iter()
                        .filter(|asset| !legacy_other_host(&asset.name, platform))
                        .cloned()
                        .collect::<Vec<_>>();
                    let resolved_tie = old
                        .as_ref()
                        .is_err_and(|error| error.code == crate::ErrorCode::Conflict)
                        && legacy_choose_asset(port, platform, &host_assets)
                            .ok()
                            .map(|asset| asset.name.as_str())
                            == new;
                    let new_is_host = new.is_none_or(|name| !legacy_other_host(name, platform));
                    let defect = (new_is_host && (wrong_host_choice || resolved_tie))
                        .then_some(Defect::WrongHostPackage);
                    record(
                        &release.tag_name,
                        "asset".into(),
                        defect,
                        format!("{old_name:?} -> {new:?}"),
                    );
                }
                for channel in [
                    ReleaseChannel::Stable,
                    ReleaseChannel::Beta,
                    ReleaseChannel::Rolling,
                ] {
                    candidates_compared += 1;
                    let select = |applies: &dyn Fn(&GithubRelease) -> bool| {
                        select_channel_candidate(
                            list,
                            channel,
                            port.release.rolling_tag.as_deref(),
                            |release| !release.draft && applies(release),
                            is_beta_release,
                            |release| release.tag_name.as_str(),
                        )
                    };
                    let old = select(&|release| {
                        legacy_native_release_applies_to_platform(port, platform, release)
                    });
                    let new = select(&|release| {
                        native_release_applies_to_platform(port, platform, release)
                    });
                    if old.map(|release| &release.tag_name) == new.map(|release| &release.tag_name)
                    {
                        continue;
                    }
                    let old = old.expect("typed stream membership only narrows");
                    // An ambiguity error alone does not qualify: legacy found
                    // no package, another host's package or a supporting file.
                    let offered_nothing_for_host =
                        match legacy_choose_asset(port, platform, &old.assets) {
                            Err(error) => error.code == crate::ErrorCode::NotFound,
                            Ok(asset) => {
                                legacy_other_host(&asset.name, platform)
                                    || legacy_supporting(&asset.name, platform)
                            }
                        };
                    let defect = (legacy_foreign_only(old, platform) && offered_nothing_for_host)
                        .then_some(Defect::ForeignOnlyReleaseHidesOlderRelease);
                    record(
                        &old.tag_name,
                        format!("{channel:?}"),
                        defect,
                        format!("-> {:?}", new.map(|release| &release.tag_name)),
                    );
                }
            }
        }
    }
    let coverage = adapters
        .iter()
        .map(|(adapter, (own, total))| format!("{adapter}: {}/{total}", own.len()))
        .collect::<Vec<_>>();
    eprintln!(
        "selection equivalence: {assets_compared} asset and {candidates_compared} candidate \
         selections; {} own port/fixture pairs; {} cross-applied exceptions\n\
         own-fixture coverage by adapter (ports with an own fixture/ports):\n  {}",
        own_pairs.len(),
        exceptions.len(),
        coverage.join("\n  ")
    );
    assert!(assets_compared > 10_000 && candidates_compared > 10_000);
    assert!(
        unexplained.is_empty(),
        "unexplained selection changes:\n{}",
        unexplained.join("\n")
    );
    // Recorded fixtures replayed against their own port: no selection changed.
    assert!(
        own_exceptions.is_empty(),
        "own-port exceptions:\n{}",
        own_exceptions.join("\n")
    );
    let own_coverage = adapters
        .iter()
        .filter(|(_, (own, _))| !own.is_empty())
        .map(|(adapter, (own, _))| (adapter.as_str(), own.len()))
        .collect::<Vec<_>>();
    assert_eq!(
        own_coverage, OWN_FIXTURE_COVERAGE,
        "own-fixture coverage changed"
    );
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(EXCEPTIONS_PATH);
    let actual = exceptions.iter().cloned().collect::<Vec<_>>().join("\n") + "\n";
    if std::env::var_os("PORTCOVE_WRITE_SELECTION_EQUIVALENCE").is_some() {
        std::fs::write(&path, &actual).unwrap();
    }
    let expected = std::fs::read_to_string(&path).unwrap();
    let expected = expected.lines().collect::<BTreeSet<_>>();
    let actual = exceptions
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    assert_eq!(
        actual.difference(&expected).collect::<Vec<_>>(),
        Vec::<&&str>::new(),
        "new exceptions"
    );
    assert_eq!(
        expected.difference(&actual).collect::<Vec<_>>(),
        Vec::<&&str>::new(),
        "listed exceptions no longer occur"
    );
}
