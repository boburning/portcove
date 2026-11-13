//! Production-provider fixtures, not upstream artifact or gameplay observations.
use super::*;

fn metadata() -> String {
    ok_json(r#"{"archived":false}"#, "")
}

fn releases(values: &[serde_json::Value]) -> String {
    ok_json(&serde_json::to_string(values).unwrap(), "")
}

fn asset(name: &str, digest: Option<char>) -> serde_json::Value {
    serde_json::json!({
        "name": name,
        "browser_download_url": format!("https://downloads.example.invalid/{name}"),
        "size": 42,
        "digest": digest.map(|value| format!("sha256:{}", value.to_string().repeat(64)))
    })
}

fn release(tag: &str, assets: Vec<serde_json::Value>) -> serde_json::Value {
    serde_json::json!({
        "tag_name": tag, "draft": false, "prerelease": false,
        "published_at": null, "assets": assets
    })
}

fn observed_rollout_releases(id: &str) -> Vec<serde_json::Value> {
    let corpus: serde_json::Value = serde_json::from_str(include_str!(
        "../../testdata/rollout-release-selection-2026-10-26.json"
    ))
    .unwrap();
    corpus["upstreams"]
        .as_array()
        .unwrap()
        .iter()
        .find(|upstream| upstream["port_id"] == id)
        .unwrap()["releases"]
        .as_array()
        .unwrap()
        .clone()
}

#[tokio::test]
async fn opensc2k_selects_linux_tarballs_with_an_unchanged_definition() {
    let catalog = crate::Catalog::embedded().unwrap();
    let port = catalog.port("nicholas-ochoa-opensc2k").unwrap();
    let mut previous = port.clone();
    previous.linux_portable_data_directory = None;
    let key =
        |port| ReleaseSelectionCacheKey::new(port, ReleaseChannel::Stable, Platform::LinuxX86_64);
    assert_ne!(key(port), key(&previous));
    let current = "OpenSC2K-0.3.0-linux-x64.tar.gz";
    let successor = "OpenSC2K-0.3.1-linux-x64.tar.gz";
    let digest = "ae590f1972bab10de02334219426c9916de6e2c528fa65709d2b22bdf1bd952c";
    let mut published = asset(current, None);
    published["digest"] = serde_json::json!(format!("sha256:{digest}"));
    published["size"] = serde_json::json!(57_273_526);
    let (root, requests, server) = serve_http(vec![
        metadata(),
        releases(&[release("v0.3.0", vec![published])]),
        metadata(),
        releases(&[release(
            "v0.3.1",
            vec![
                asset("OpenSC2K-0.3.1-linux-arm64.tar.gz", Some('b')),
                asset("OpenSC2K-0.3.1-windows-x64-portable.zip", Some('c')),
                asset("OpenSC2K-0.3.1-macos-universal.dmg", Some('d')),
                asset("OpenSC2K-0.3.1-linux-x64.tar.gz.zip", Some('e')),
                asset("mirror-OpenSC2K-0.3.1-linux-x64.tar.gz", Some('f')),
                asset("OpenSC2K-experimental-linux-x64.tar.gz", Some('e')),
                asset(successor, Some('a')),
            ],
        )]),
    ]);
    for (name, expected, root) in [
        (current, digest.to_string(), root.clone()),
        (successor, "a".repeat(64), root),
    ] {
        let resolved = GithubReleaseProvider::with_api_root(root)
            .unwrap()
            .resolve(port, ReleaseChannel::Stable, Platform::LinuxX86_64)
            .await
            .unwrap();
        assert_eq!(resolved.asset.name, name);
        assert_eq!(resolved.asset.sha256, expected);
    }
    server.join().unwrap();
    assert_eq!(requests.try_iter().count(), 4);
}

#[tokio::test]
async fn openmohaa_unix_selects_official_zip_and_compatible_successor() {
    let id = "medal-of-honor-allied-assault-openmohaa";
    let catalog = crate::Catalog::embedded().unwrap();
    let port = catalog.port(id).unwrap();
    let fixtures: serde_json::Value = serde_json::from_str(include_str!(
        "../../testdata/native-engine-adoption-2026-11-02.json"
    ))
    .unwrap();
    let case = fixtures["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["port_id"] == id)
        .unwrap();
    let observed = &case["release"];
    let assets = observed["assets"].as_array().unwrap();
    let next = release(
        "v0.82.2",
        assets
            .iter()
            .map(|original| {
                let name = original["name"]
                    .as_str()
                    .unwrap()
                    .replace("v0.82.1", "v0.82.2");
                asset(&name, Some('b'))
            })
            .collect(),
    );
    for (platform, suffix, digest) in [
        (
            Platform::LinuxX86_64,
            "-linux-amd64.zip",
            "57692d057a684afb7f7e91a61fcd8c062b29ab1b639f27453830084a88cd653c",
        ),
        (
            Platform::MacosX86_64,
            "-macos-multiarch-arm64-x86_64.zip",
            "dd590e887078912e0bd80ad3e9d414ef7611faada064e7e49b4c3eafa59e579a",
        ),
        (
            Platform::MacosAarch64,
            "-macos-multiarch-arm64-x86_64.zip",
            "dd590e887078912e0bd80ad3e9d414ef7611faada064e7e49b4c3eafa59e579a",
        ),
    ] {
        let (root, requests, server) = serve_http(vec![
            metadata(),
            releases(std::slice::from_ref(observed)),
            metadata(),
            releases(std::slice::from_ref(&next)),
        ]);
        let provider = GithubReleaseProvider::with_api_root(root.clone()).unwrap();
        let baseline = provider
            .resolve(port, ReleaseChannel::Stable, platform)
            .await
            .unwrap();
        assert_eq!(baseline.asset.name, format!("openmohaa-v0.82.1{suffix}"));
        assert_eq!(baseline.asset.sha256, digest);
        let successor = GithubReleaseProvider::with_api_root(root)
            .unwrap()
            .resolve(port, ReleaseChannel::Stable, platform)
            .await
            .unwrap();
        assert_eq!(successor.asset.name, format!("openmohaa-v0.82.2{suffix}"));
        assert_eq!(successor.asset.sha256, "b".repeat(64));
        server.join().unwrap();
        assert_eq!(requests.try_iter().count(), 4);
    }
}

#[test]
fn openmohaa_unix_selector_cannot_reuse_a_broader_cached_release() {
    let catalog = crate::Catalog::embedded().unwrap();
    let port = catalog
        .port("medal-of-honor-allied-assault-openmohaa")
        .unwrap();
    let mut broader = port.clone();
    broader.external_profile_policy = None;
    let channel = ReleaseChannel::Stable;
    let key = |port, platform| ReleaseSelectionCacheKey::new(port, channel, platform);
    for platform in [
        Platform::LinuxX86_64,
        Platform::MacosX86_64,
        Platform::MacosAarch64,
    ] {
        assert_ne!(key(port, platform), key(&broader, platform));
    }
    assert_eq!(
        key(port, Platform::WindowsX86_64),
        key(&broader, Platform::WindowsX86_64)
    );
}

#[test]
fn openjo_unix_selector_cannot_reuse_a_broader_cached_release() {
    let catalog = crate::Catalog::embedded().unwrap();
    let port = catalog
        .port("star-wars-jedi-knight-ii-jedi-outcast-single-player-openjk-openjo")
        .unwrap();
    let mut broader = port.clone();
    broader.external_profile_policy = None;
    let key =
        |port, platform| ReleaseSelectionCacheKey::new(port, ReleaseChannel::Rolling, platform);
    for platform in [
        Platform::LinuxX86_64,
        Platform::MacosX86_64,
        Platform::MacosAarch64,
    ] {
        assert_ne!(key(port, platform), key(&broader, platform));
    }
    assert_eq!(
        key(port, Platform::WindowsX86_64),
        key(&broader, Platform::WindowsX86_64)
    );
}

#[tokio::test]
async fn quake_linux_selects_the_official_package_and_compatible_successor() {
    let catalog = crate::Catalog::embedded().unwrap();
    for (id, current, next, alternatives, digest, size) in [
        (
            "quake-ironwail",
            "ironwail-0.8.2-linux-x64.tar.gz",
            "ironwail-0.8.3-linux-x64.tar.gz",
            [
                "ironwail-0.8.3-win64.zip",
                "ironwail-0.8.3-linux-arm64.tar.gz",
                "ironwail-0.8.3-linux-x64.tar.gz.zip",
                "mirror-ironwail-0.8.3-linux-x64.tar.gz",
            ],
            "fcb0219d13c50f64728892f0558b4761ba5578319a6cc01021fad981c6333aa5",
            592_534,
        ),
        (
            "quake-vkquake",
            "vkQuake-1.37.0-x86_64.AppImage",
            "vkQuake-1.38.0-x86_64.AppImage",
            [
                "vkQuake-1.38.0_windows_x64.zip",
                "vkQuake-1.38.0-aarch64.AppImage",
                "vkQuake-1.38.0-x86_64.AppImage.zip",
                "mirror-vkQuake-1.38.0-x86_64.AppImage",
            ],
            "abf8546316997d16b86fea242d90afc8203fecb9e5016d6262f7bec1f36a5a9e",
            9_538_040,
        ),
    ] {
        let port = catalog.port(id).unwrap();
        let mut broad = port.clone();
        broad.external_profile_policy = None;
        let key =
            |port, platform| ReleaseSelectionCacheKey::new(port, ReleaseChannel::Stable, platform);
        assert_ne!(
            key(port, Platform::LinuxX86_64),
            key(&broad, Platform::LinuxX86_64)
        );
        assert_eq!(
            key(port, Platform::WindowsX86_64),
            key(&broad, Platform::WindowsX86_64)
        );
        let mut observed = asset(current, None);
        observed["digest"] = serde_json::json!(format!("sha256:{digest}"));
        observed["size"] = serde_json::json!(size);
        let mut next_assets = vec![asset(next, Some('a'))];
        next_assets.extend(alternatives.map(|name| asset(name, Some('b'))));
        let (root, requests, server) = serve_http(vec![
            metadata(),
            releases(&[release(current.split('-').nth(1).unwrap(), vec![observed])]),
            metadata(),
            releases(&[release(next.split('-').nth(1).unwrap(), next_assets)]),
        ]);
        for (name, expected, root) in [
            (current, digest.to_string(), root.clone()),
            (next, "a".repeat(64), root),
        ] {
            let release = GithubReleaseProvider::with_api_root(root)
                .unwrap()
                .resolve(port, ReleaseChannel::Stable, Platform::LinuxX86_64)
                .await
                .unwrap();
            assert_eq!(release.asset.name, name);
            assert_eq!(release.asset.sha256, expected);
        }
        server.join().unwrap();
        assert_eq!(requests.try_iter().count(), 4);
    }
}

#[tokio::test]
async fn profile_siblings_select_official_archives_and_compatible_successors() {
    let catalog = crate::Catalog::embedded().unwrap();
    for (id, platform, current, successor, digest, size) in [
        (
            "corsixth-corsixth",
            Platform::LinuxX86_64,
            "CorsixTH-v0.70.2-x86_64.AppImage",
            "CorsixTH-v0.70.3-x86_64.AppImage",
            "106aa756cfbd59be153067f63fa8ac8b2090996752853cd4f03d03425011237e",
            82_872_824,
        ),
        (
            "openloco-openloco",
            Platform::LinuxX86_64,
            "OpenLoco-v26.09-linux-x64.AppImage",
            "OpenLoco-v26.10.1-linux-x64.AppImage",
            "353750c8cee127aa24ce2e3cc7e8233c14fe37362bd62f6b3c3d6887a7d16fb3",
            17_680_888,
        ),
        (
            "openloco-openloco",
            Platform::MacosAarch64,
            "OpenLoco-v26.09-macos-arm64.zip",
            "OpenLoco-v26.10-macos-arm64.zip",
            "15cd95be662810cae3a16bc8053b2cb3cd2bc680fc29ac486322c3e00fe6da1e",
            17_557_193,
        ),
    ] {
        let port = catalog.port(id).unwrap();
        let mut broad = port.clone();
        broad.external_profile_policy = None;
        let key = |port| ReleaseSelectionCacheKey::new(port, ReleaseChannel::Stable, platform);
        assert_ne!(key(port), key(&broad));
        let mut published = asset(current, None);
        published["digest"] = serde_json::json!(format!("sha256:{digest}"));
        published["size"] = serde_json::json!(size);
        let (root, requests, server) = serve_http(vec![
            metadata(),
            releases(&[release(current.split('-').nth(1).unwrap(), vec![published])]),
            metadata(),
            releases(&[release(
                successor.split('-').nth(1).unwrap(),
                vec![
                    asset(successor, Some('a')),
                    asset(&format!("mirror-{successor}"), Some('b')),
                    asset(&format!("{successor}.zip"), Some('c')),
                ],
            )]),
        ]);
        for (name, expected, root) in [
            (current, digest.to_string(), root.clone()),
            (successor, "a".repeat(64), root),
        ] {
            let resolved = GithubReleaseProvider::with_api_root(root)
                .unwrap()
                .resolve(port, ReleaseChannel::Stable, platform)
                .await
                .unwrap();
            assert_eq!(resolved.asset.name, name);
            assert_eq!(resolved.asset.sha256, expected);
        }
        server.join().unwrap();
        assert_eq!(requests.try_iter().count(), 4);
    }
}

#[tokio::test]
async fn archive_siblings_select_two_compatible_publisher_releases() {
    let catalog = crate::Catalog::embedded().unwrap();
    for (id, platform, releases_to_check) in [
        (
            "jgrennison-openttd-patches",
            Platform::LinuxX86_64,
            [
                (
                    "jgrpp-0.73.4",
                    "openttd-jgrpp-0.73.4-linux-generic-amd64.tar.xz",
                    "9df78eaa8157fff3c310345554b34dbd3ecc6d14e3988f91e3c25b5330940511",
                ),
                (
                    "jgrpp-0.73.5",
                    "openttd-jgrpp-0.73.5-linux-generic-amd64.tar.xz",
                    "2de4dc6fa93115ddc4c2ff58f6a70e78056e726a182d2f986a06c0f07227097d",
                ),
            ],
        ),
        (
            "gladiator-openglad",
            Platform::MacosAarch64,
            [
                (
                    "v2.1097",
                    "openglad-macos-arm64.zip",
                    "09ada009f20138f1c592a4edb93809aafcc7058290034ce462e2e71b4028ed89",
                ),
                (
                    "v2.1098",
                    "openglad-macos-arm64.zip",
                    "037fbef7fac1460235b39fb923515b72ef7f784967a2f6b6f62194a7b5353a71",
                ),
            ],
        ),
    ] {
        let port = catalog.port(id).unwrap();
        let mut broad = port.clone();
        broad.external_profile_policy = None;
        let key = |port| ReleaseSelectionCacheKey::new(port, ReleaseChannel::Stable, platform);
        assert_ne!(key(port), key(&broad));
        for (tag, name, digest) in releases_to_check {
            let mut published = asset(name, None);
            published["digest"] = serde_json::json!(format!("sha256:{digest}"));
            let (root, requests, server) = serve_http(vec![
                metadata(),
                releases(&[release(
                    tag,
                    vec![asset(&format!("mirror-{name}"), Some('b')), published],
                )]),
            ]);
            let resolved = GithubReleaseProvider::with_api_root(root)
                .unwrap()
                .resolve(port, ReleaseChannel::Stable, platform)
                .await
                .unwrap();
            assert_eq!(resolved.asset.name, name);
            assert_eq!(resolved.asset.sha256, digest);
            server.join().unwrap();
            assert_eq!(requests.try_iter().count(), 2);
        }
    }
}

#[tokio::test]
async fn recomp_appimages_select_the_direct_linux_asset_and_compatible_successor() {
    let catalog = crate::Catalog::embedded().unwrap();
    for (id, name, tag, size, sha256) in [
        (
            "thatguymcd-glover-r",
            "Glover-R",
            "v1.0.1",
            18_987_512_u64,
            "765325f48cbe2fc4646a638faf75d971c7f122980b08b6bdedb148a8513296ca",
        ),
        (
            "rocket-robot-on-wheels-rocket-r",
            "Rocket-R",
            "v.1.0.1",
            21_637_624_u64,
            "82048c0d7a8ab5555ea5f663cde7cec1563f799913ed390b12d0f6e35d9618ee",
        ),
    ] {
        let port = catalog.port(id).unwrap();
        let platform = Platform::LinuxX86_64;
        let current_name = format!("{name}-1.0.1-Linux-x86_64.AppImage");
        let next_name = format!("{name}-1.0.2-Linux-x86_64.AppImage");
        let mut observed = asset(&current_name, None);
        observed["size"] = serde_json::json!(size);
        observed["digest"] = serde_json::json!(format!("sha256:{sha256}"));
        let current = release(tag, vec![observed]);
        let wrong = [
            format!("{name}-1.0.2-Linux-aarch64.AppImage"),
            format!("{name}-1.0.2-Linux-x86_64-SteamDeck.AppImage"),
            format!("{name}-1.0.2-Linux-x86_64-Portable.tar.gz"),
            format!("{name}-debug-1.0.2-Linux-x86_64.AppImage"),
        ];
        let mut next_assets = vec![asset(&next_name, Some('a'))];
        next_assets.extend(wrong.iter().map(|name| asset(name, Some('b'))));
        let next = release("v1.0.2", next_assets);
        let (root, _, server) = serve_http(vec![
            metadata(),
            releases(&[current]),
            metadata(),
            releases(&[next]),
        ]);
        let observed = GithubReleaseProvider::with_api_root(root.clone())
            .unwrap()
            .resolve(port, ReleaseChannel::Stable, platform)
            .await
            .unwrap();
        assert_eq!(observed.asset.name, current_name);
        assert_eq!(observed.asset.size, size);
        assert_eq!(observed.asset.sha256, sha256);
        let successor = GithubReleaseProvider::with_api_root(root)
            .unwrap()
            .resolve(port, ReleaseChannel::Stable, platform)
            .await
            .unwrap();
        assert_eq!(successor.asset.name, next_name);
        assert_eq!(successor.asset.sha256, "a".repeat(64));
        assert!(crate::managed_runtime_policy::requires_provider_resolution_on(port, platform));
        for name in wrong {
            assert!(
                crate::managed_runtime_policy::require_native_appimage_artifact(
                    port, platform, &name
                )
                .is_err()
            );
        }
        crate::managed_runtime_policy::require_native_appimage_artifact(port, platform, &next_name)
            .unwrap();
        server.join().unwrap();
    }
}

#[tokio::test]
async fn openrct2_both_mac_architectures_follow_the_official_universal_bundle() {
    let catalog = crate::Catalog::embedded().unwrap();
    let port = catalog.port("openrct2-openrct2").unwrap();
    let archive = "OpenRCT2-v0.5.7-macos-universal.zip";
    let sha256 = "fd71e17c8ee5e8bd5887e2b1e269d7bdd0c7cee056997cdc6b55813ed395fed3";
    let mut observed = asset(archive, None);
    observed["size"] = serde_json::json!(115_868_444_u64);
    observed["digest"] = serde_json::json!(format!("sha256:{sha256}"));
    let current = release(
        "v0.5.7",
        vec![
            observed,
            asset("OpenRCT2-v0.5.7-windows-portable-x64.zip", Some('a')),
            asset("OpenRCT2-v0.5.7-Linux-bookworm-x86_64.tar.gz", Some('b')),
        ],
    );
    let successor_name = "OpenRCT2-v0.5.8-macos-universal.zip";
    let successor = release(
        "v0.5.8",
        vec![
            asset(successor_name, Some('c')),
            asset("OpenRCT2-v0.5.8-macos-arm64.zip", Some('d')),
            asset("OpenRCT2-v0.5.8-macos-universal.dmg", Some('e')),
        ],
    );
    for platform in [Platform::MacosX86_64, Platform::MacosAarch64] {
        let (root, _, server) = serve_http(vec![
            metadata(),
            releases(std::slice::from_ref(&current)),
            metadata(),
            releases(std::slice::from_ref(&successor)),
        ]);
        let old = GithubReleaseProvider::with_api_root(root.clone())
            .unwrap()
            .resolve(port, ReleaseChannel::Stable, platform)
            .await
            .unwrap();
        assert_eq!(old.asset.name, archive);
        assert_eq!(old.asset.size, 115_868_444);
        assert_eq!(old.asset.sha256, sha256);
        let next = GithubReleaseProvider::with_api_root(root)
            .unwrap()
            .resolve(port, ReleaseChannel::Stable, platform)
            .await
            .unwrap();
        assert_eq!(next.asset.name, successor_name);
        assert_eq!(next.asset.sha256, "c".repeat(64));
        server.join().unwrap();
    }
}

#[tokio::test]
async fn native10_original_sibling_assets_follow_stable_successors() {
    let catalog = crate::Catalog::embedded().unwrap();
    for (record, ids, routes, tag) in [
        (
            include_str!("../../testdata/bstone-release-selection-2026-10-29.json"),
            [
                "blake-stone-aliens-of-gold-bstone",
                "blake-stone-planet-strike-bstone",
            ],
            &[
                (Platform::LinuxX86_64, "bstone-1.3.4+e65a6b40-Linux.zip"),
                (Platform::MacosX86_64, "bstone-1.3.4+e65a6b40-Darwin.zip"),
            ][..],
            "v1.3.5",
        ),
        (
            include_str!("../../testdata/devilution-release-selection-2026-10-29.json"),
            ["diablo-devilutionx", "diablo-hellfire-devilutionx"],
            &[(Platform::LinuxX86_64, "devilutionx-linux-x86_64.appimage")][..],
            "1.5.6",
        ),
    ] {
        let captured: serde_json::Value = serde_json::from_str(record).unwrap();
        let observed = &captured["release"];
        let mut next = observed.clone();
        next["tag_name"] = serde_json::json!(tag);
        for row in next["assets"].as_array_mut().unwrap() {
            let name = row["name"]
                .as_str()
                .unwrap()
                .replace("1.3.4+e65a6b40", "1.3.5+01234567");
            *row = asset(&name, Some('c'));
        }
        for id in ids {
            let port = catalog.port(id).unwrap();
            for &(platform, name) in routes {
                let selected = observed["assets"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|row| row["name"] == name)
                    .unwrap();
                let (root, _, server) = serve_http(vec![
                    metadata(),
                    releases(std::slice::from_ref(observed)),
                    metadata(),
                    releases(std::slice::from_ref(&next)),
                ]);
                let current = GithubReleaseProvider::with_api_root(root.clone())
                    .unwrap()
                    .resolve(port, ReleaseChannel::Stable, platform)
                    .await
                    .unwrap();
                assert_eq!(current.asset.name, name);
                assert_eq!(current.asset.size, selected["size"].as_u64().unwrap());
                assert_eq!(
                    format!("sha256:{}", current.asset.sha256),
                    selected["digest"]
                );
                let successor = GithubReleaseProvider::with_api_root(root)
                    .unwrap()
                    .resolve(port, ReleaseChannel::Stable, platform)
                    .await
                    .unwrap();
                assert_eq!(successor.version, tag);
                assert_eq!(
                    successor.asset.name,
                    name.replace("1.3.4+e65a6b40", "1.3.5+01234567")
                );
                assert_eq!(successor.asset.sha256, "c".repeat(64));
                server.join().unwrap();
            }
        }
    }
}

#[test]
fn native10_appimage_selector_refuses_archive_fallback_and_legacy_routes() {
    let catalog = crate::Catalog::embedded().unwrap();
    let mut port = catalog.port("diablo-devilutionx").unwrap().clone();
    let platform = Platform::LinuxX86_64;
    let assets = serde_json::from_value::<Vec<GithubAsset>>(serde_json::json!([
        asset("devilutionx-linux-x86_64.tar.gz", Some('d')),
        asset(
            "devilutionx-linux-x86_64.appimage.unreviewed.appimage",
            Some('d')
        ),
    ]))
    .unwrap();
    assert_eq!(
        choose_asset(&port, platform, &assets).unwrap_err().code,
        crate::ErrorCode::NotFound
    );
    let appimage = serde_json::from_value::<GithubAsset>(asset(
        "devilutionx-linux-x86_64.appimage",
        Some('d'),
    ))
    .unwrap();
    assert!(choose_asset(&port, platform, std::slice::from_ref(&appimage)).is_ok());
    port.windows_temp_directory = None;
    assert!(choose_asset(&port, platform, std::slice::from_ref(&appimage)).is_err());
}

#[tokio::test]
async fn bstone_definitions_keep_win64_identity_and_refuse_unqualified_metadata() {
    let catalog = crate::Catalog::embedded().unwrap();
    let captured: serde_json::Value = serde_json::from_str(include_str!(
        "../../testdata/bstone-release-selection-2026-10-29.json"
    ))
    .unwrap();
    let observed = &captured["release"];
    let name = "bstone-1.3.4+e65a6b40-win64.zip";
    let selected = observed["assets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|asset| asset["name"] == name)
        .unwrap();
    for id in [
        "blake-stone-aliens-of-gold-bstone",
        "blake-stone-planet-strike-bstone",
    ] {
        let port = catalog.port(id).unwrap();
        let definition = serde_json::to_value(port).unwrap();
        let mut synthetic = observed.clone();
        synthetic["tag_name"] = serde_json::json!("v1.3.5");
        for asset in synthetic["assets"].as_array_mut().unwrap() {
            let next = asset["name"]
                .as_str()
                .unwrap()
                .replace("1.3.4+e65a6b40", "1.3.5+01234567");
            asset["name"] = serde_json::json!(next);
            asset["browser_download_url"] =
                serde_json::json!(format!("https://downloads.example.invalid/{next}"));
            asset["digest"] = serde_json::json!(format!("sha256:{}", "b".repeat(64)));
        }
        let (root, requests, server) = serve_http(vec![
            metadata(),
            releases(std::slice::from_ref(observed)),
            metadata(),
            releases(&[synthetic]),
        ]);
        let old = GithubReleaseProvider::with_api_root(root.clone())
            .unwrap()
            .resolve(port, ReleaseChannel::Stable, Platform::WindowsX86_64)
            .await
            .unwrap();
        assert_eq!(old.version, "v1.3.4");
        assert_eq!(old.asset.name, name);
        assert_eq!(old.asset.size, 2_081_399);
        assert_eq!(
            old.asset.sha256,
            "4bfe5c0bef00395a667a2c594399b13a1faddf817da602a38bff2fa80e02cd45"
        );
        let next = GithubReleaseProvider::with_api_root(root)
            .unwrap()
            .resolve(port, ReleaseChannel::Stable, Platform::WindowsX86_64)
            .await
            .unwrap();
        assert_eq!(next.version, "v1.3.5");
        assert_eq!(next.asset.name, "bstone-1.3.5+01234567-win64.zip");
        assert_eq!(next.asset.sha256, "b".repeat(64));
        server.join().unwrap();
        assert_eq!(requests.try_iter().count(), 4);
        for mutation in ["wrong-cpu", "ambiguous", "missing-integrity"] {
            let mut player = selected.clone();
            match mutation {
                "wrong-cpu" => {
                    player["name"] = serde_json::json!(name.replace("win64", "win32"));
                }
                "missing-integrity" => player["digest"] = serde_json::Value::Null,
                _ => {}
            }
            let mut candidates = vec![player.clone()];
            if mutation == "ambiguous" {
                player["name"] = serde_json::json!(name.replace("e65a6b40", "alternate"));
                candidates.push(player);
            }
            let (root, _, server) =
                serve_http(vec![metadata(), releases(&[release("v1.3.5", candidates)])]);
            let error = GithubReleaseProvider::with_api_root(root)
                .unwrap()
                .resolve(port, ReleaseChannel::Stable, Platform::WindowsX86_64)
                .await
                .unwrap_err();
            assert_eq!(
                error.code,
                match mutation {
                    "ambiguous" => crate::ErrorCode::Conflict,
                    "missing-integrity" => crate::ErrorCode::Verification,
                    _ => crate::ErrorCode::NotFound,
                },
                "{id}: {mutation}"
            );
            server.join().unwrap();
        }
        // Metadata progression grants no original/edition/save qualification.
        assert_eq!(serde_json::to_value(port).unwrap(), definition);
    }
}

#[tokio::test]
async fn devilution_definitions_follow_stable_win64_packages_and_refuse_unsafe_metadata() {
    let catalog = crate::Catalog::embedded().unwrap();
    let captured: serde_json::Value = serde_json::from_str(include_str!(
        "../../testdata/devilution-release-selection-2026-10-29.json"
    ))
    .unwrap();
    let observed = &captured["release"];
    let name = "devilutionx-windows-x86_64.zip";
    let selected = observed["assets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|asset| asset["name"] == name)
        .unwrap();
    for id in ["diablo-devilutionx", "diablo-hellfire-devilutionx"] {
        let port = catalog.port(id).unwrap();
        let definition = serde_json::to_value(port).unwrap();
        // Only N is observed metadata. N+1 and its digest are controlled
        // fixtures; they establish unchanged selection, not save compatibility.
        let mut successor = observed.clone();
        successor["tag_name"] = serde_json::json!("1.5.6");
        for asset in successor["assets"].as_array_mut().unwrap() {
            let next = asset["name"].as_str().unwrap().to_owned();
            asset["browser_download_url"] =
                serde_json::json!(format!("https://downloads.example.invalid/{next}"));
            asset["digest"] = serde_json::json!(format!("sha256:{}", "b".repeat(64)));
        }
        let (root, requests, server) = serve_http(vec![
            metadata(),
            releases(std::slice::from_ref(observed)),
            metadata(),
            releases(std::slice::from_ref(&successor)),
        ]);
        let baseline = GithubReleaseProvider::with_api_root(root.clone())
            .unwrap()
            .resolve(port, ReleaseChannel::Stable, Platform::WindowsX86_64)
            .await
            .unwrap();
        assert_eq!(baseline.version, "1.5.5");
        assert_eq!(baseline.asset.name, name);
        assert_eq!(baseline.asset.size, 10_482_049);
        assert_eq!(
            baseline.asset.sha256,
            "a20cfb62cd611f76aac78f9bf09a28f57794fbfe63ae6da9245deca446680b2b"
        );
        let next = GithubReleaseProvider::with_api_root(root)
            .unwrap()
            .resolve(port, ReleaseChannel::Stable, Platform::WindowsX86_64)
            .await
            .unwrap();
        assert_eq!(next.version, "1.5.6");
        assert_eq!(next.asset.name, name);
        assert_eq!(next.asset.sha256, "b".repeat(64));
        server.join().unwrap();
        assert_eq!(requests.try_iter().count(), 4);
        for mutation in [
            "wrong-cpu",
            "wrong-platform",
            "ambiguous",
            "missing-integrity",
        ] {
            let mut player = selected.clone();
            match mutation {
                "wrong-cpu" => {
                    player["name"] = serde_json::json!("devilutionx-windows-i686.zip");
                }
                "wrong-platform" => {
                    player["name"] = serde_json::json!("devilutionx-linux-x86_64.zip");
                }
                "missing-integrity" => player["digest"] = serde_json::Value::Null,
                _ => {}
            }
            let mut assets = vec![player.clone()];
            if mutation == "ambiguous" {
                player["id"] = serde_json::json!(999_999_999);
                player["name"] = serde_json::json!("DevilutionX-windows-x86_64.zip");
                player["browser_download_url"] = serde_json::json!(
                    "https://downloads.example.invalid/DevilutionX-windows-x86_64.zip"
                );
                assets.push(player);
            }
            let (root, _, server) =
                serve_http(vec![metadata(), releases(&[release("1.5.6", assets)])]);
            let failure = GithubReleaseProvider::with_api_root(root)
                .unwrap()
                .resolve(port, ReleaseChannel::Stable, Platform::WindowsX86_64)
                .await
                .unwrap_err();
            assert_eq!(
                failure.code,
                match mutation {
                    "ambiguous" => crate::ErrorCode::Conflict,
                    "missing-integrity" => crate::ErrorCode::Verification,
                    _ => crate::ErrorCode::NotFound,
                },
                "{id}: {mutation}"
            );
            server.join().unwrap();
        }
        assert_eq!(serde_json::to_value(port).unwrap(), definition);
    }
}

#[tokio::test]
async fn crispy_definitions_select_their_family_and_reject_unsafe_successors() {
    let catalog = crate::Catalog::embedded().unwrap();
    let observed: serde_json::Value = serde_json::from_str(include_str!(
        "../../testdata/crispy-release-selection-2026-10-29.json"
    ))
    .unwrap();
    let observed = &observed["release"];
    for (id, family) in [
        ("doom-the-ultimate-doom-crispy-doom-family", "doom"),
        ("doom-ii-crispy-doom-family", "doom"),
        ("final-doom-crispy-doom-family", "doom"),
        ("heretic-crispy-doom-family", "heretic"),
        ("hexen-crispy-doom-family", "hexen"),
        ("strife-crispy-doom-family", "strife"),
    ] {
        let port = catalog.port(id).unwrap();
        let definition = serde_json::to_value(port).unwrap();
        let name = format!("crispy-{family}-7.2.0-win64.zip");
        let selected = observed["assets"]
            .as_array()
            .unwrap()
            .iter()
            .find(|asset| asset["name"] == name)
            .unwrap();
        // Only the first response is observed upstream metadata. N+1 and every
        // refusal below are controlled fixtures, not accepted future artifacts.
        let mut successor = observed.clone();
        successor["tag_name"] = serde_json::json!("crispy-doom-7.3");
        for asset in successor["assets"].as_array_mut().unwrap() {
            let next = asset["name"].as_str().unwrap().replace("7.2.0", "7.3.0");
            asset["name"] = serde_json::json!(next);
            asset["browser_download_url"] =
                serde_json::json!(format!("https://downloads.example.invalid/{next}"));
            asset["digest"] = serde_json::json!(format!("sha256:{}", "a".repeat(64)));
        }
        let (root, requests, server) = serve_http(vec![
            metadata(),
            releases(std::slice::from_ref(observed)),
            metadata(),
            releases(std::slice::from_ref(&successor)),
        ]);
        let baseline = GithubReleaseProvider::with_api_root(root.clone())
            .unwrap()
            .resolve(port, ReleaseChannel::Stable, Platform::WindowsX86_64)
            .await
            .unwrap();
        assert_eq!(baseline.version, "crispy-doom-7.2");
        assert_eq!(baseline.asset.name, name);
        assert_eq!(baseline.asset.size, selected["size"].as_u64().unwrap());
        assert_eq!(
            baseline.asset.sha256,
            selected["digest"]
                .as_str()
                .unwrap()
                .strip_prefix("sha256:")
                .unwrap()
        );
        let next = GithubReleaseProvider::with_api_root(root)
            .unwrap()
            .resolve(port, ReleaseChannel::Stable, Platform::WindowsX86_64)
            .await
            .unwrap();
        assert_eq!(next.version, "crispy-doom-7.3");
        assert_eq!(next.asset.name, name.replace("7.2.0", "7.3.0"));
        assert_eq!(next.asset.sha256, "a".repeat(64));
        server.join().unwrap();
        assert_eq!(requests.try_iter().count(), 4);

        for mutation in [
            "wrong-cpu",
            "wrong-family",
            "ambiguous",
            "missing-integrity",
        ] {
            let mut player = selected.clone();
            match mutation {
                "wrong-cpu" => player["name"] = serde_json::json!(name.replace("win64", "arm64")),
                "wrong-family" => {
                    player["name"] = serde_json::json!(name.replace(family, "unrelated"))
                }
                "missing-integrity" => player["digest"] = serde_json::Value::Null,
                _ => {}
            }
            let mut assets = vec![player.clone()];
            if mutation == "ambiguous" {
                player["name"] = serde_json::json!(name.replace("7.2.0", "7.2.1"));
                assets.push(player);
            }
            let failure_release = release("crispy-doom-7.3", assets);
            let (root, _, server) = serve_http(vec![metadata(), releases(&[failure_release])]);
            let failure = GithubReleaseProvider::with_api_root(root)
                .unwrap()
                .resolve(port, ReleaseChannel::Stable, Platform::WindowsX86_64)
                .await
                .unwrap_err();
            assert_eq!(
                failure.code,
                match mutation {
                    "ambiguous" => crate::ErrorCode::Conflict,
                    "missing-integrity" => crate::ErrorCode::Verification,
                    _ => crate::ErrorCode::NotFound,
                },
                "{id}: {mutation}"
            );
            server.join().unwrap();
        }
        assert_eq!(serde_json::to_value(port).unwrap(), definition);
    }
}

#[tokio::test]
async fn observed_rollout_metadata_progresses_with_unchanged_authored_definitions() {
    let catalog = crate::Catalog::embedded().unwrap();
    for (id, platform, old_index, expected_tag, expected_name) in [
        (
            "road-rash-64-recompiled",
            Platform::WindowsX86_64,
            1,
            "v1.4.8",
            "RoadRash64Recompiled-v1.4.8-Win64.zip",
        ),
        (
            "sonic-3-and-knuckles-recomp",
            Platform::WindowsX86_64,
            1,
            "v0.6.0",
            "Sonic3KRecomp-windows-x64-v0.6.0.zip",
        ),
        (
            "blizz127-brave-fencer-musashi-decomp-port",
            Platform::WindowsX86_64,
            2,
            "bfm-r48-1e23c3d4f",
            "bfm-r48-355ec7668-windows-x64.zip",
        ),
        (
            "blizz127-brave-fencer-musashi-decomp-port",
            Platform::LinuxX86_64,
            2,
            "bfm-r55-ba90b87ad",
            "bfm-r55-ba90b87ad-linux-x86_64.tar.gz",
        ),
    ] {
        let port = catalog.port(id).unwrap();
        let definition = serde_json::to_vec(port).unwrap();
        let observed = observed_rollout_releases(id);
        let old = &observed[old_index];
        let channel = if id == "blizz127-brave-fencer-musashi-decomp-port" {
            ReleaseChannel::Beta
        } else {
            ReleaseChannel::Stable
        };
        let (root, requests, server) = serve_http(vec![
            metadata(),
            releases(std::slice::from_ref(old)),
            metadata(),
            releases(&observed),
        ]);
        let baseline = GithubReleaseProvider::with_api_root(root.clone())
            .unwrap()
            .resolve(port, channel, platform)
            .await
            .unwrap();
        assert_eq!(
            baseline.version,
            old["tag_name"].as_str().unwrap(),
            "{id}: {platform:?}"
        );
        let successor = GithubReleaseProvider::with_api_root(root)
            .unwrap()
            .resolve(port, channel, platform)
            .await
            .unwrap();
        assert_eq!(successor.version, expected_tag, "{id}: {platform:?}");
        assert_eq!(successor.asset.name, expected_name);
        let expected = observed
            .iter()
            .flat_map(|release| release["assets"].as_array().unwrap())
            .find(|asset| asset["name"] == expected_name)
            .unwrap();
        assert_eq!(successor.asset.size, expected["size"].as_u64().unwrap());
        assert_eq!(
            successor.asset.sha256,
            expected["digest"]
                .as_str()
                .unwrap()
                .strip_prefix("sha256:")
                .unwrap()
        );
        assert_eq!(serde_json::to_vec(port).unwrap(), definition);
        server.join().unwrap();
        assert_eq!(requests.try_iter().count(), 4);
    }
}

#[tokio::test]
async fn observed_rollout_metadata_keeps_synthetic_successor_refusals_authoritative() {
    let catalog = crate::Catalog::embedded().unwrap();
    for (id, selected_name) in [
        (
            "road-rash-64-recompiled",
            "RoadRash64Recompiled-v1.4.8-Win64.zip",
        ),
        (
            "sonic-3-and-knuckles-recomp",
            "Sonic3KRecomp-windows-x64-v0.6.0.zip",
        ),
    ] {
        let port = catalog.port(id).unwrap();
        for mutation in ["wrong-cpu", "debug", "ambiguous", "missing-integrity"] {
            let mut observed = observed_rollout_releases(id);
            let mut player = observed[0]["assets"]
                .as_array()
                .unwrap()
                .iter()
                .find(|asset| asset["name"] == selected_name)
                .unwrap()
                .clone();
            match mutation {
                "wrong-cpu" => {
                    player["name"] = serde_json::json!(
                        selected_name
                            .replace("Win64", "Win-arm64")
                            .replace("windows-x64", "windows-arm64")
                    )
                }
                "debug" => {
                    player["name"] = serde_json::json!(selected_name.replace("-v", "-debug-v"))
                }
                "missing-integrity" => player["digest"] = serde_json::Value::Null,
                _ => {}
            }
            let mut assets = vec![player.clone()];
            if mutation == "ambiguous" {
                player["name"] = serde_json::json!(selected_name.replace("-v", "-alternate-v"));
                assets.push(player);
            }
            // Synthetic metadata contains no checksum sidecar or alternate player.
            observed[0]["assets"] = serde_json::json!(assets);
            let (root, _, server) = serve_http(vec![metadata(), releases(&observed)]);
            let failure = GithubReleaseProvider::with_api_root(root)
                .unwrap()
                .resolve(port, ReleaseChannel::Stable, Platform::WindowsX86_64)
                .await
                .unwrap_err();
            assert_eq!(
                failure.code,
                match mutation {
                    "ambiguous" => crate::ErrorCode::Conflict,
                    "missing-integrity" => crate::ErrorCode::Verification,
                    _ => crate::ErrorCode::NotFound,
                },
                "{id}: {mutation}"
            );
            server.join().unwrap();
        }
    }
}

#[tokio::test]
async fn observed_openciv3_preview_uses_shared_classification_despite_the_provider_flag() {
    let observed = observed_rollout_releases("c7-game-openciv3");
    assert_eq!(observed[0]["prerelease"], false);
    for (channel, index) in [(ReleaseChannel::Beta, 0), (ReleaseChannel::Stable, 1)] {
        let expected = &observed[index];
        let (root, requests, server) = serve_http(vec![
            releases(&observed),
            ok_json(&serde_json::to_string(&expected["assets"]).unwrap(), ""),
        ]);
        let (candidates, coverage, summaries, selected) =
            GithubReleaseProvider::with_api_root(root)
                .unwrap()
                .catalog_download_options("C7-Game/OpenCiv3", None, channel, None)
                .await
                .unwrap();
        assert_eq!(selected, expected["id"].as_u64());
        assert_eq!(candidates.len(), 3);
        assert!(coverage.candidates_complete && coverage.release_history_complete);
        assert!(summaries[0].preview);
        assert!(!summaries[1].preview);
        server.join().unwrap();
        assert_eq!(requests.try_iter().count(), 2);
    }
    // This replays metadata selection only. The authored acquisition hold and
    // existing-copy permission boundary remain enforced by the service tests.
    assert!(
        crate::Catalog::embedded()
            .unwrap()
            .listing("c7-game-openciv3")
            .unwrap()
            .download_block_reason
            .is_some()
    );
}

#[tokio::test]
async fn unchanged_closed_policy_rules_resolve_successors_with_exact_provider_bindings() {
    let catalog = crate::Catalog::embedded().unwrap();
    for (id, versions, names) in [
        (
            "the-force-engine-dark-forces",
            ["v1.22.410", "v1.22.420"],
            [
                "TheForceEngine-v1.22.410.zip",
                "TheForceEngine-v1.22.420.zip",
            ],
        ),
        (
            "resident-evil-gaiden-recomp",
            ["v0.4.0", "v0.4.1"],
            [
                "Resident_Evil_Gaiden_Recomp_v0.4.0_Windows.zip",
                "Resident_Evil_Gaiden_Recomp_v0.4.1_Windows.zip",
            ],
        ),
        (
            "wave-race-64-racewave46",
            ["v1.0.0", "v1.0.1"],
            [
                "RaceWave46-Windows-x64-v1.0.0.zip",
                "RaceWave46-Windows-x64-v1.0.1.zip",
            ],
        ),
    ] {
        // Use the actual authored rules unchanged. Release responses and digests
        // remain fixtures; RaceWave46 v1.0.1 is a controlled synthetic successor.
        let port = catalog.port(id).unwrap();
        assert_eq!(port.release.provider, crate::ReleaseSource::Github);
        crate::runtime::validate(port).unwrap();
        let (root, requests, server) = serve_http(vec![
            metadata(),
            releases(&[release(versions[0], vec![asset(names[0], Some('a'))])]),
            metadata(),
            releases(&[
                release(versions[1], vec![asset(names[1], Some('b'))]),
                release(versions[0], vec![asset(names[0], Some('a'))]),
            ]),
        ]);
        // Separate provider instances represent a fresh observation after N+1.
        for (index, version) in versions.iter().enumerate() {
            let provider = GithubReleaseProvider::with_api_root(root.clone()).unwrap();
            let resolved = provider
                .resolve_scoped(port, ReleaseChannel::Stable, Platform::WindowsX86_64, None)
                .await
                .unwrap();
            resolved
                .require_selection(port, Platform::WindowsX86_64, ReleaseChannel::Stable)
                .unwrap();
            assert_eq!(resolved.release.version, *version);
            assert_eq!(resolved.release.asset.name, names[index]);
            let actual = crate::ArtifactIdentity {
                asset_name: resolved.release.asset.name.clone(),
                sha256: resolved.release.asset.sha256.clone(),
                size: resolved.release.asset.size,
            };
            crate::managed_runtime_policy::require_artifact(
                port,
                version,
                &actual,
                Some(Platform::WindowsX86_64),
            )
            .unwrap();
        }
        server.join().unwrap();
        assert_eq!(requests.try_iter().count(), 4);
    }
}

#[tokio::test]
async fn unchanged_authored_rules_follow_versioned_packages_after_cache_expiry_and_on_fresh_install()
 {
    let catalog = crate::Catalog::embedded().unwrap();
    for (id, old_tag, old_name, new_tag, new_name) in [
        // MC2 has one observed native player release; v0.1.4 is synthetic.
        (
            "alariq-mc2",
            "v0.1.3",
            "mc2-win64-v0.1.3.zip",
            "v0.1.4",
            "mc2-win64-v0.1.4.zip",
        ),
        (
            "battletanx-global-assault-pc-port",
            "v0.2.4",
            "BattleTanxGA-0.2.4-windows-x64-portable.zip",
            "v0.2.5",
            "BattleTanxGA-0.2.5-windows-x64-portable.zip",
        ),
        (
            "brawmario-infinite-mario-64-ever",
            "v0.1.4",
            "infinite-mario-64-ever.v0.1.4.windows.zip",
            "v0.1.5",
            "infinite-mario-64-ever.v0.1.5.windows.zip",
        ),
        (
            "dkc1-recomp",
            "v0.0.16",
            "DKC1Recomp-v0.0.16-Windows-x64.zip",
            "v0.0.17",
            "DKC1Recomp-v0.0.17-Windows-x64.zip",
        ),
        // v1.4.9 is controlled; the current v1.4.8 Windows package is observed.
        (
            "road-rash-64-recompiled",
            "v1.4.8",
            "RoadRash64Recompiled-v1.4.8-Win64.zip",
            "v1.4.9",
            "RoadRash64Recompiled-v1.4.9-Win64.zip",
        ),
        // Controlled successors exercise stable rules; they do not assert that
        // F-Zero1.8.4, DKC3.0.0.7 or Bomberman.0.1.2 have been published.
        (
            "f-zero-snes-recomp",
            "v1.8.3",
            "FZeroSNESRecomp-1.8.3-windows-x64.zip",
            "v1.8.4",
            "FZeroSNESRecomp-1.8.4-windows-x64.zip",
        ),
        (
            "dkc3-recomp",
            "v0.0.6",
            "DKC3Recomp-v0.0.6-windows-x64.zip",
            "v0.0.7",
            "DKC3Recomp-v0.0.7-windows-x64.zip",
        ),
        (
            "super-mario-world-recomp",
            "v0.12.0",
            "SuperMarioWorldRecomp-windows-x64-v0.12.0.zip",
            "v0.15.1",
            "SuperMarioWorldRecomp-windows-x64-v0.15.1.zip",
        ),
        (
            "the-legend-of-zelda-a-link-to-the-past-snes-recomp",
            "v0.6.1",
            "ZeldaALttPSNESRecomp-windows-x64-v0.6.1.zip",
            "v0.6.5",
            "ZeldaALttPSNESRecomp-windows-x64-v0.6.5.zip",
        ),
        (
            "sonic-the-hedgehog-2-recomp",
            "v0.8.3",
            "SonicTheHedgehog2Recomp-windows-x64-v0.8.3.zip",
            "v0.9.0",
            "SonicTheHedgehog2Recomp-windows-x64-v0.9.0.zip",
        ),
        // v0.6.1 is a controlled successor, not a published-release claim.
        (
            "sonic-3-and-knuckles-recomp",
            "v0.6.0",
            "Sonic3KRecomp-windows-x64-v0.6.0.zip",
            "v0.6.1",
            "Sonic3KRecomp-windows-x64-v0.6.1.zip",
        ),
        (
            "super-bomberman-recomp",
            "v0.1.1",
            "BombermanRecomp-windows-x64-v0.1.1.zip",
            "v0.1.2",
            "BombermanRecomp-windows-x64-v0.1.2.zip",
        ),
        // v0.5.1 is a controlled successor, not a published-release claim.
        (
            "goldeneye-007-n64-pc-port",
            "v0.5.0",
            "goldeneye-pc-port-0.5.0-win64.zip",
            "v0.5.1",
            "goldeneye-pc-port-0.5.1-win64.zip",
        ),
    ] {
        // Use each adopted route’s actual shipped rules unchanged.
        let port = catalog.port(id).unwrap();
        let old = release(old_tag, vec![asset(old_name, Some('a'))]);
        let new = release(
            new_tag,
            vec![
                asset(new_name, Some('b')),
                asset(
                    &new_name
                        .replace("windows", "linux")
                        .replace("Windows", "Linux")
                        .replace("Win64", "Linux64")
                        .replace("win64", "linux64"),
                    Some('c'),
                ),
                asset(
                    &new_name
                        .replace("x64", "arm64")
                        .replace("win64", "win-arm64")
                        .replace("Win64", "Win-arm64")
                        .replace(".windows.zip", ".windows-arm64.zip"),
                    Some('d'),
                ),
                asset(&new_name.replace(".zip", "-symbols.zip"), Some('e')),
                asset(&new_name.replace(".zip", "-source.zip"), Some('f')),
                asset(&format!("{new_name}.sha256"), None),
            ],
        );
        let current = vec![new.clone(), old.clone()];
        let (api_root, requests, server) = serve_http(vec![
            metadata(),
            releases(&[old]),
            metadata(), // Unexpired selection still checks repository state.
            metadata(),
            releases(&current),
            metadata(),
            releases(&current),
        ]);
        let provider = GithubReleaseProvider::with_api_root(api_root.clone()).unwrap();
        let baseline = provider
            .resolve(port, ReleaseChannel::Stable, Platform::WindowsX86_64)
            .await
            .unwrap();
        assert_eq!(baseline.asset.name, old_name, "{id}");
        let cached = provider
            .resolve(port, ReleaseChannel::Stable, Platform::WindowsX86_64)
            .await
            .unwrap();
        assert_eq!(
            cached.asset, baseline.asset,
            "bounded cache delay is deliberate"
        );
        for entry in provider.cache.write().await.values_mut() {
            entry.stored_at -= RELEASE_CACHE_TTL + Duration::from_secs(1);
        }
        let successor = provider
            .resolve(port, ReleaseChannel::Stable, Platform::WindowsX86_64)
            .await
            .unwrap();
        let fresh = GithubReleaseProvider::with_api_root(api_root)
            .unwrap()
            .resolve(port, ReleaseChannel::Stable, Platform::WindowsX86_64)
            .await
            .unwrap();
        server.join().unwrap();
        assert_eq!(successor.version, release_version(new_tag), "{id}");
        assert_eq!(successor.asset.name, new_name, "{id}");
        assert_eq!(successor.asset.sha256, "b".repeat(64), "{id}");
        assert_eq!(
            fresh.asset, successor.asset,
            "fresh installation after N+1: {id}"
        );
        assert_eq!(
            requests.try_iter().count(),
            7,
            "same definition/provider and a fresh client: {id}"
        );
    }
}

fn variant_port() -> PortDefinition {
    let mut port = crate::Catalog::embedded()
        .unwrap()
        .port("fragglet-sdl-sopwith")
        .unwrap()
        .clone();
    port.release.repository = "example/game".into();
    port.release.asset_hints.insert(
        Platform::WindowsX86_64,
        vec!["Game-hd-".into(), "-windows-x64.zip".into()],
    );
    port
}

#[tokio::test]
async fn observed_native_archive_layouts_resolve_successors_without_definition_changes() {
    let catalog = crate::Catalog::embedded().unwrap();
    // Observed names/sizes/digests; controlled HTTP replay, no artifact execution.
    for (id, old_tag, new_tag, platform, packages) in [
        (
            "diegodedios-alienrerecomp",
            "v0.1.7",
            "v0.1.8",
            Platform::WindowsX86_64,
            [
                (
                    "AlienResurrection-0.1.7-windows-x64.zip",
                    "67c9a5c7cba0bcd7a888226041f788e19470c9cabf7626ab537dcc75e9da657b",
                    2_763_329_u64,
                ),
                (
                    "AlienResurrection-0.1.8-windows-x64.zip",
                    "ec74b39e6d3827f62f2dd2cfe73cc582721834da6ebc1b03b36417d1ee40e48f",
                    2_763_454,
                ),
            ],
        ),
        (
            "diegodedios-alienrerecomp",
            "v0.1.7",
            "v0.1.8",
            Platform::LinuxX86_64,
            [
                (
                    "AlienResurrection-0.1.7-linux-x86_64.tar.gz",
                    "ace1b401ac8643b59c12486cca2f646201792f5b92af024b90cea7132dff4773",
                    2_564_446,
                ),
                (
                    "AlienResurrection-0.1.8-linux-x86_64.tar.gz",
                    "12c5790d50dee8a64ed03b5f7780f14e4a75612773b6dbc5b252d0f0545b007d",
                    2_564_673,
                ),
            ],
        ),
        (
            "mr-finster-stunts-hd",
            "v1.5.21",
            "v1.5.22",
            Platform::WindowsX86_64,
            [
                (
                    "Stunts-HD-win-x64.zip",
                    "866b95cb379e1f49da69f324d07372800328bb4641c4df7a8857732e1cabc392",
                    111_603_100,
                ),
                (
                    "Stunts-HD-win-x64.zip",
                    "118f0598916966bb8d79f3786016e94c8cb8dce57b7e97c02240c41c8d52aaf5",
                    111_604_171,
                ),
            ],
        ),
        (
            "mr-finster-stunts-hd",
            "v1.5.21",
            "v1.5.22",
            Platform::LinuxX86_64,
            [
                (
                    "Stunts-HD-linux-x64.tar.gz",
                    "d465c2949157a1ae6baae8859e942cf3009cb4cbe8126bc1e0618e2050ed2f46",
                    102_788_078,
                ),
                (
                    "Stunts-HD-linux-x64.tar.gz",
                    "693ab6cc4c8d96df57752c28df0e0f65a5bb56635a8d08eec57098da83c48543",
                    102_789_136,
                ),
            ],
        ),
    ] {
        let port = catalog.port(id).unwrap();
        let [old_asset, new_asset] = packages.map(|(name, digest, size)| {
            let mut value = asset(name, None);
            value["digest"] = format!("sha256:{digest}").into();
            value["size"] = size.into();
            value
        });
        let old = release(old_tag, vec![old_asset]);
        let current = [release(new_tag, vec![new_asset]), old.clone()];
        let (root, requests, server) = serve_http(vec![
            metadata(),
            releases(&[old]),
            metadata(),
            metadata(),
            releases(&current),
            metadata(),
            releases(&current),
        ]);
        let provider = GithubReleaseProvider::with_api_root(root.clone()).unwrap();
        let baseline = provider
            .resolve(port, ReleaseChannel::Stable, platform)
            .await
            .unwrap();
        let cached = provider
            .resolve(port, ReleaseChannel::Stable, platform)
            .await
            .unwrap();
        assert_eq!(cached.asset, baseline.asset);
        for entry in provider.cache.write().await.values_mut() {
            entry.stored_at -= RELEASE_CACHE_TTL + Duration::from_secs(1);
        }
        let successor = provider
            .resolve(port, ReleaseChannel::Stable, platform)
            .await
            .unwrap();
        let fresh = GithubReleaseProvider::with_api_root(root)
            .unwrap()
            .resolve(port, ReleaseChannel::Stable, platform)
            .await
            .unwrap();
        for (resolved, (name, digest, size), version) in [
            (&baseline, packages[0], old_tag),
            (&successor, packages[1], new_tag),
            (&fresh, packages[1], new_tag),
        ] {
            assert_eq!(resolved.version, version);
            assert_eq!(resolved.asset.name, name);
            assert_eq!(resolved.asset.sha256, digest);
            assert_eq!(resolved.asset.size, size);
        }
        server.join().unwrap();
        assert_eq!(requests.try_iter().count(), 7);
    }
}

#[tokio::test]
async fn unchanged_beta_staged_rules_follow_player_successors_and_skip_compliance_archives() {
    let catalog = crate::Catalog::embedded().unwrap();
    // Successors are controlled fixtures, not published upstream releases.
    for (id, old_tag, old_name, new_tag, new_name) in [
        (
            "leithsilver-mgsm",
            "v0.1",
            "MGS_Mobile_0.1_Windows_x64.zip",
            "v0.2",
            "MGS_Mobile_0.2_Windows_x64.zip",
        ),
        (
            "infinite-undiscovery-doc-haz",
            "v1.0.0-rc1",
            "InfiniteUndiscoveryRecomp-v1.0.0-rc1.zip",
            "v1.0.0-rc2",
            "InfiniteUndiscoveryRecomp-v1.0.0-rc2.zip",
        ),
        (
            "crash-team-racing-ctr-native",
            "beta-7.1",
            "ctr-native-beta-7_1-windows-x86.zip",
            "beta-7.2",
            "ctr-native-beta-7_2-windows-x86.zip",
        ),
        (
            "mstan-supermarioadvance4recomp",
            "v0.0.3",
            "SuperMarioAdvance4Recomp-windows-x64-v0.0.3.zip",
            "v0.0.4",
            "SuperMarioAdvance4Recomp-windows-x64-v0.0.4.zip",
        ),
        (
            "mstan-wariowaretwistedrecomp",
            "v0.0.2",
            "WarioWareTwistedRecomp-windows-x64-v0.0.2.zip",
            "v0.0.3",
            "WarioWareTwistedRecomp-windows-x64-v0.0.3.zip",
        ),
    ] {
        let port = catalog.port(id).unwrap();
        let mut old = release(old_tag, vec![asset(old_name, Some('a'))]);
        old["prerelease"] = true.into();
        // Replace an existing processor label. Appending ARM64 to an x64 name
        // describes a universal package, which is a real competing choice.
        let other_arch = if new_name.contains("x64") {
            new_name.replace("x64", "arm64")
        } else {
            new_name.replace(".zip", "-arm64.zip")
        };
        let mut next = release(
            new_tag,
            vec![
                asset(new_name, Some('b')),
                asset(&new_name.replace(".zip", "-LGPL-Compliance.zip"), Some('c')),
                asset(&other_arch, Some('d')),
                asset(&new_name.replace(".zip", "-symbols.zip"), Some('e')),
                asset(&format!("{new_name}.sha256"), None),
            ],
        );
        next["prerelease"] = true.into();
        let current = vec![next, old.clone()];
        let (root, requests, server) = serve_http(vec![
            metadata(),
            releases(&[old]),
            metadata(),
            metadata(),
            releases(&current),
            metadata(),
            releases(&current),
        ]);
        let provider = GithubReleaseProvider::with_api_root(root.clone()).unwrap();
        let baseline = provider
            .resolve(port, ReleaseChannel::Beta, Platform::WindowsX86_64)
            .await
            .unwrap();
        assert_eq!(baseline.asset.name, old_name, "{id}");
        assert_eq!(
            provider
                .resolve(port, ReleaseChannel::Beta, Platform::WindowsX86_64)
                .await
                .unwrap()
                .asset,
            baseline.asset
        );
        for value in provider.cache.write().await.values_mut() {
            value.stored_at -= RELEASE_CACHE_TTL + Duration::from_secs(1);
        }
        let successor = provider
            .resolve(port, ReleaseChannel::Beta, Platform::WindowsX86_64)
            .await
            .unwrap();
        let fresh = GithubReleaseProvider::with_api_root(root)
            .unwrap()
            .resolve(port, ReleaseChannel::Beta, Platform::WindowsX86_64)
            .await
            .unwrap();
        server.join().unwrap();
        assert_eq!(successor.version, release_version(new_tag), "{id}");
        assert_eq!(successor.asset.name, new_name, "{id}");
        assert_eq!(successor.asset.sha256, "b".repeat(64));
        assert_eq!(
            fresh.asset, successor.asset,
            "fresh successor install: {id}"
        );
        assert_eq!(requests.try_iter().count(), 7);
    }
}

#[tokio::test]
async fn successor_resolution_refuses_lost_variant_ambiguity_wrong_architecture_and_missing_integrity()
 {
    for adapter in [
        AdapterKind::NativePortable,
        AdapterKind::StagedSourcePortable,
        AdapterKind::N64RecompPortable,
    ] {
        let mut port = variant_port();
        port.adapter = adapter;
        port.n64_runtime_at_executable_parent = adapter == AdapterKind::N64RecompPortable;
        let old = release(
            "v1.0.0",
            vec![asset("Game-hd-v1.0.0-windows-x64.zip", Some('a'))],
        );
        for (name, candidates, expected) in [
            (
                "missing selected variant",
                vec![asset("Game-standard-v2.0.0-windows-x64.zip", Some('b'))],
                crate::ErrorCode::NotFound,
            ),
            (
                "competing selected variants",
                vec![
                    asset("Game-hd-one-v2.0.0-windows-x64.zip", Some('b')),
                    asset("Game-hd-two-v2.0.0-windows-x64.zip", Some('c')),
                ],
                crate::ErrorCode::Conflict,
            ),
            (
                "wrong architecture",
                vec![asset("Game-hd-v2.0.0-windows-arm64.zip", Some('b'))],
                crate::ErrorCode::NotFound,
            ),
            (
                "source archive only",
                vec![asset("Game-hd-source-v2.0.0-windows-x64.zip", Some('b'))],
                crate::ErrorCode::NotFound,
            ),
            (
                "missing independent digest",
                vec![asset("Game-hd-v2.0.0-windows-x64.zip", None)],
                crate::ErrorCode::Verification,
            ),
        ] {
            let (api_root, _, server) = serve_http(vec![
                metadata(),
                releases(&[release("v2.0.0", candidates), old.clone()]),
            ]);
            let failure = GithubReleaseProvider::with_api_root(api_root)
                .unwrap()
                .resolve(&port, ReleaseChannel::Stable, Platform::WindowsX86_64)
                .await
                .unwrap_err();
            server.join().unwrap();
            assert_eq!(
                failure.code, expected,
                "{adapter:?}: {name}; never silently fall back to N"
            );
        }
    }
}

#[tokio::test]
async fn a_renamed_successor_asset_fails_closed_instead_of_falling_back_to_the_previous_release() {
    let port = variant_port();
    let old = release(
        "v1.0.0",
        vec![asset("Game-hd-v1.0.0-windows-x64.zip", Some('a'))],
    );
    // The successor keeps the platform tokens but upstream renamed the product, so
    // the reviewed selector no longer matches. The route stays unavailable until a
    // reviewed definition change; it never resolves to the older release.
    let renamed = release(
        "v2.0.0",
        vec![asset("NewName-hd-v2.0.0-windows-x64.zip", Some('b'))],
    );
    let (api_root, _, server) = serve_http(vec![metadata(), releases(&[renamed, old])]);
    let failure = GithubReleaseProvider::with_api_root(api_root)
        .unwrap()
        .resolve(&port, ReleaseChannel::Stable, Platform::WindowsX86_64)
        .await
        .unwrap_err();
    server.join().unwrap();
    assert_eq!(failure.code, crate::ErrorCode::NotFound);
}

#[tokio::test]
async fn successor_checksum_must_name_the_successor_asset() {
    let port = variant_port();
    let new_name = "Game-hd-v2.0.0-windows-x64.zip";
    for (manifest_name, expected) in [("Game-hd-v1.0.0-windows-x64.zip", false), (new_name, true)] {
        let digest = "b".repeat(64);
        let (download_root, _, checksum_server) =
            serve_http(vec![ok_json(&format!("{digest}  {manifest_name}"), "")]);
        let sidecar = serde_json::json!({"name":"SHA256SUMS.txt", "browser_download_url":format!("{download_root}/SHA256SUMS.txt"), "size":200, "digest":null});
        let (api_root, _, server) = serve_http(vec![
            metadata(),
            releases(&[release("v2.0.0", vec![asset(new_name, None), sidecar])]),
        ]);
        let result = GithubReleaseProvider::with_api_root(api_root)
            .unwrap()
            .resolve(&port, ReleaseChannel::Stable, Platform::WindowsX86_64)
            .await;
        server.join().unwrap();
        checksum_server.join().unwrap();
        if expected {
            assert_eq!(result.unwrap().asset.sha256, digest);
        } else {
            assert_eq!(result.unwrap_err().code, crate::ErrorCode::Verification);
        }
    }
}

#[tokio::test]
async fn cached_package_selection_cannot_cross_adapter_package_contracts() {
    let mut port = variant_port();
    port.platforms.push(Platform::LinuxX86_64);
    port.adapter = AdapterKind::LibultrashipPortable;
    port.release
        .asset_hints
        .insert(Platform::LinuxX86_64, vec!["Game-".into()]);
    let current = release("v1.0.0", vec![asset("Game-linux-x64.AppImage", Some('a'))]);
    let (api_root, requests, server) = serve_http(vec![
        metadata(),
        releases(std::slice::from_ref(&current)),
        metadata(),
        releases(&[current]),
    ]);
    let provider = GithubReleaseProvider::with_api_root(api_root).unwrap();
    let first = provider
        .resolve(&port, ReleaseChannel::Stable, Platform::LinuxX86_64)
        .await
        .unwrap();
    assert!(first.asset.name.ends_with(".AppImage"));
    port.adapter = AdapterKind::NativePortable;
    let failure = provider
        .resolve(&port, ReleaseChannel::Stable, Platform::LinuxX86_64)
        .await
        .unwrap_err();
    server.join().unwrap();
    assert_eq!(failure.code, crate::ErrorCode::NotFound);
    assert_eq!(
        requests.try_iter().count(),
        4,
        "native archive restrictions must be evaluated again"
    );
}

#[tokio::test]
async fn cached_package_selection_cannot_cross_n64_root_package_contracts() {
    let mut port = variant_port();
    port.adapter = AdapterKind::N64RecompPortable;
    // Historical N64 hints were preferences. A definition opting in to strict
    // executable-parent packages must not reuse that cached selection.
    let current = release(
        "v1.0.0",
        vec![asset("Game-hd-v1.0.0-windows-x86.zip", Some('a'))],
    );
    let (api_root, requests, server) = serve_http(vec![
        metadata(),
        releases(std::slice::from_ref(&current)),
        metadata(),
        releases(&[current]),
    ]);
    let provider = GithubReleaseProvider::with_api_root(api_root).unwrap();
    let historical = provider
        .resolve(&port, ReleaseChannel::Stable, Platform::WindowsX86_64)
        .await
        .unwrap();
    assert!(historical.asset.name.ends_with("windows-x86.zip"));
    port.n64_runtime_at_executable_parent = true;
    let failure = provider
        .resolve(&port, ReleaseChannel::Stable, Platform::WindowsX86_64)
        .await
        .unwrap_err();
    server.join().unwrap();
    assert_eq!(failure.code, crate::ErrorCode::NotFound);
    assert_eq!(requests.try_iter().count(), 4);
}

// Actual reviewed package names paired with controlled version-only successors.
// v999.123.456 is fixture data, not an observed upstream release or game test.
#[tokio::test]
async fn adopted_psx_rules_follow_successors_for_every_reviewed_platform_scope() {
    let catalog = crate::Catalog::embedded().unwrap();
    for (id, platform, old_tag, old_name, new_name) in [
        (
            "alexbeav-ace-combat-3-electrosphere-recomp",
            Platform::WindowsX86_64,
            "v0.3.6",
            "Ace-Combat-3-Electrosphere-Japan-Recomp-0.3.6-windows-x64.zip",
            "Ace-Combat-3-Electrosphere-Japan-Recomp-999.123.456-windows-x64.zip",
        ),
        (
            "alexbeav-ace-combat-3-electrosphere-recomp",
            Platform::LinuxX86_64,
            "v0.3.6",
            "Ace-Combat-3-Electrosphere-Japan-Recomp-0.3.6-linux-x64.zip",
            "Ace-Combat-3-Electrosphere-Japan-Recomp-999.123.456-linux-x64.zip",
        ),
        (
            "alexbeav-alien-resurrection-recomp",
            Platform::WindowsX86_64,
            "v0.1.4",
            "alien-resurrection-recomp-0.1.4-windows-x64.zip",
            "alien-resurrection-recomp-999.123.456-windows-x64.zip",
        ),
        (
            "alexbeav-alien-resurrection-recomp",
            Platform::LinuxX86_64,
            "v0.1.4",
            "alien-resurrection-recomp-0.1.4-linux-x64.zip",
            "alien-resurrection-recomp-999.123.456-linux-x64.zip",
        ),
        (
            "alexbeav-alundra-recomp",
            Platform::WindowsX86_64,
            "v0.3.6",
            "Alundra-Recomp-0.3.6-windows-x64.zip",
            "Alundra-Recomp-999.123.456-windows-x64.zip",
        ),
        (
            "alexbeav-ape-escape-recomp",
            Platform::WindowsX86_64,
            "v0.3.6",
            "Ape-Escape-Recomp-0.3.6-windows-x64.zip",
            "Ape-Escape-Recomp-999.123.456-windows-x64.zip",
        ),
        (
            "alexbeav-armored-core-recomp",
            Platform::WindowsX86_64,
            "v0.3.6",
            "Armored-Core-Recomp-0.3.6-windows-x64.zip",
            "Armored-Core-Recomp-999.123.456-windows-x64.zip",
        ),
        (
            "alexbeav-blood-omen-legacy-of-kain-recomp",
            Platform::WindowsX86_64,
            "v0.3.6",
            "Blood-Omen-Legacy-of-Kain-Recomp-0.3.6-windows-x64.zip",
            "Blood-Omen-Legacy-of-Kain-Recomp-999.123.456-windows-x64.zip",
        ),
        (
            "alexbeav-brave-fencer-musashi-recomp",
            Platform::WindowsX86_64,
            "v0.1.3",
            "brave-fencer-musashi-recomp-0.1.3-windows-x64.zip",
            "brave-fencer-musashi-recomp-999.123.456-windows-x64.zip",
        ),
        (
            "alexbeav-brave-fencer-musashi-recomp",
            Platform::LinuxX86_64,
            "v0.1.3",
            "brave-fencer-musashi-recomp-0.1.3-linux-x64.zip",
            "brave-fencer-musashi-recomp-999.123.456-linux-x64.zip",
        ),
        (
            "alexbeav-diablo-recomp",
            Platform::WindowsX86_64,
            "v0.1.4",
            "diablo-recomp-0.1.4-windows-x64.zip",
            "diablo-recomp-999.123.456-windows-x64.zip",
        ),
        (
            "alexbeav-diablo-recomp",
            Platform::LinuxX86_64,
            "v0.1.4",
            "diablo-recomp-0.1.4-linux-x64.zip",
            "diablo-recomp-999.123.456-linux-x64.zip",
        ),
        (
            "alexbeav-digimon-world-2003-recomp",
            Platform::WindowsX86_64,
            "v0.3.6",
            "Digimon-World-2003-Recomp-0.3.6-windows-x64.zip",
            "Digimon-World-2003-Recomp-999.123.456-windows-x64.zip",
        ),
        (
            "alexbeav-dino-crisis-2-recomp",
            Platform::WindowsX86_64,
            "v0.1.1",
            "dino-crisis-2-0.1.1-windows-x64.zip",
            "dino-crisis-2-999.123.456-windows-x64.zip",
        ),
        (
            "alexbeav-dino-crisis-2-recomp",
            Platform::LinuxX86_64,
            "v0.1.1",
            "dino-crisis-2-0.1.1-linux-x64.zip",
            "dino-crisis-2-999.123.456-linux-x64.zip",
        ),
        (
            "alexbeav-dino-crisis-recomp",
            Platform::WindowsX86_64,
            "v0.1.1",
            "dino-crisis-0.1.1-windows-x64.zip",
            "dino-crisis-999.123.456-windows-x64.zip",
        ),
        (
            "alexbeav-dino-crisis-recomp",
            Platform::LinuxX86_64,
            "v0.1.1",
            "dino-crisis-0.1.1-linux-x64.zip",
            "dino-crisis-999.123.456-linux-x64.zip",
        ),
        (
            "alexbeav-driver-recomp",
            Platform::WindowsX86_64,
            "v0.3.6",
            "Driver-Recomp-0.3.6-windows-x64.zip",
            "Driver-Recomp-999.123.456-windows-x64.zip",
        ),
        (
            "alexbeav-duke-nukem-land-of-the-babes-recomp",
            Platform::WindowsX86_64,
            "v0.3.6",
            "Duke-Nukem-Land-of-the-Babes-Recomp-0.3.6-windows-x64.zip",
            "Duke-Nukem-Land-of-the-Babes-Recomp-999.123.456-windows-x64.zip",
        ),
        (
            "alexbeav-duke-nukem-time-to-kill-recomp",
            Platform::WindowsX86_64,
            "v0.3.6",
            "Duke-Nukem-Time-to-Kill-Recomp-0.3.6-windows-x64.zip",
            "Duke-Nukem-Time-to-Kill-Recomp-999.123.456-windows-x64.zip",
        ),
        (
            "alexbeav-fade-to-black-recomp",
            Platform::WindowsX86_64,
            "v0.3.6",
            "Fade-to-Black-Recomp-0.3.6-windows-x64.zip",
            "Fade-to-Black-Recomp-999.123.456-windows-x64.zip",
        ),
    ] {
        let port = catalog.port(id).unwrap();
        assert_eq!(port.adapter, AdapterKind::PsxRecompManaged);
        assert_eq!(port.release.provider, crate::ReleaseSource::Github);
        let old = release(old_tag, vec![asset(old_name, Some('a'))]);
        let new = release(
            "v999.123.456",
            vec![
                asset(new_name, Some('b')),
                asset(&new_name.replace("-x64.", "-arm64."), Some('c')),
                asset(&format!("{new_name}.sha256"), None),
            ],
        );
        let current = [new, old.clone()];
        let (root, requests, server) = serve_http(vec![
            metadata(),
            releases(&[old]),
            metadata(),
            metadata(),
            releases(&current),
            metadata(),
            releases(&current),
        ]);
        let provider = GithubReleaseProvider::with_api_root(root.clone()).unwrap();
        let initial = provider
            .resolve_scoped(port, ReleaseChannel::Stable, platform, None)
            .await
            .unwrap();
        initial
            .require_selection(port, platform, ReleaseChannel::Stable)
            .unwrap();
        assert_eq!(initial.release.asset.name, old_name, "{id}: {platform:?}");
        let cached = provider
            .resolve_scoped(port, ReleaseChannel::Stable, platform, None)
            .await
            .unwrap();
        assert_eq!(cached.release.asset, initial.release.asset);
        for entry in provider.cache.write().await.values_mut() {
            entry.stored_at -= RELEASE_CACHE_TTL + Duration::from_secs(1);
        }
        let successor = provider
            .resolve_scoped(port, ReleaseChannel::Stable, platform, None)
            .await
            .unwrap();
        successor
            .require_selection(port, platform, ReleaseChannel::Stable)
            .unwrap();
        assert_eq!(successor.release.version, "v999.123.456");
        assert_eq!(successor.release.asset.name, new_name, "{id}: {platform:?}");
        assert_eq!(successor.release.asset.sha256, "b".repeat(64));
        let fresh = GithubReleaseProvider::with_api_root(root)
            .unwrap()
            .resolve_scoped(port, ReleaseChannel::Stable, platform, None)
            .await
            .unwrap();
        fresh
            .require_selection(port, platform, ReleaseChannel::Stable)
            .unwrap();
        assert_eq!(
            fresh.release.asset, successor.release.asset,
            "Fresh installation after N+1: {id}: {platform:?}"
        );
        server.join().unwrap();
        assert_eq!(requests.try_iter().count(), 7);
    }
}

#[tokio::test]
async fn psx_package_rules_refuse_variant_fallback_but_keep_owned_input_preparation_kits() {
    let mut port = crate::Catalog::embedded()
        .unwrap()
        .port("revelations-persona-recompiled")
        .unwrap()
        .clone();
    port.release.repository = "example/game".into();
    port.release.asset_hints.insert(
        Platform::WindowsX86_64,
        vec!["Game-hd-".into(), "-windows-x64-owned-input.zip".into()],
    );
    for (names, code) in [
        (
            vec!["Game-standard-v2-windows-x64-owned-input.zip"],
            crate::ErrorCode::NotFound,
        ),
        (
            vec!["Game-hd-v2-windows-x64.zip"],
            crate::ErrorCode::NotFound,
        ),
        (
            vec!["Game-hd-v2-windows-arm64-owned-input.zip"],
            crate::ErrorCode::NotFound,
        ),
        (
            vec![
                "Game-hd-one-v2-windows-x64-owned-input.zip",
                "Game-hd-two-v2-windows-x64-owned-input.zip",
            ],
            crate::ErrorCode::Conflict,
        ),
    ] {
        let (root, _, server) = serve_http(vec![
            metadata(),
            releases(&[release(
                "v2",
                names
                    .into_iter()
                    .map(|name| asset(name, Some('b')))
                    .collect(),
            )]),
        ]);
        let error = GithubReleaseProvider::with_api_root(root)
            .unwrap()
            .resolve(&port, ReleaseChannel::Stable, Platform::WindowsX86_64)
            .await
            .unwrap_err();
        server.join().unwrap();
        assert_eq!(error.code, code);
    }
    // A preparation kit can legitimately contain source. PSX keeps its own
    // package contract rather than inheriting the native-player-only assessor.
    let name = "Game-hd-source-v2-windows-x64-owned-input.zip";
    let (root, _, server) = serve_http(vec![
        metadata(),
        releases(&[release("v2", vec![asset(name, Some('b'))])]),
    ]);
    let result = GithubReleaseProvider::with_api_root(root)
        .unwrap()
        .resolve(&port, ReleaseChannel::Stable, Platform::WindowsX86_64)
        .await
        .unwrap();
    server.join().unwrap();
    assert_eq!(result.asset.name, name);
    let (root, _, server) = serve_http(vec![
        metadata(),
        releases(&[release("v2", vec![asset(name, None)])]),
    ]);
    let error = GithubReleaseProvider::with_api_root(root)
        .unwrap()
        .resolve(&port, ReleaseChannel::Stable, Platform::WindowsX86_64)
        .await
        .unwrap_err();
    server.join().unwrap();
    assert_eq!(error.code, crate::ErrorCode::Verification);
}

fn asymmetric_native_port() -> PortDefinition {
    let mut port = variant_port();
    port.channels = vec![ReleaseChannel::Stable, ReleaseChannel::Beta];
    port.platforms.push(Platform::LinuxX86_64);
    port.release.asset_hints.insert(
        Platform::LinuxX86_64,
        vec!["Game-hd-".into(), "-linux-x64.tar.gz".into()],
    );
    port
}

fn preview(tag: &str, assets: Vec<serde_json::Value>) -> serde_json::Value {
    let mut value = release(tag, assets);
    value["prerelease"] = serde_json::json!(true);
    value
}

#[tokio::test]
async fn native_platform_streams_resolve_asymmetric_previews_and_stable_fallback() {
    let port = asymmetric_native_port();
    let windows = preview("r48", vec![asset("Game-hd-r48-windows-x64.zip", Some('a'))]);
    let linux = preview(
        "r55",
        vec![
            asset("Game-hd-r55-linux-x64.tar.gz", Some('b')),
            asset("openal_1.0.orig.tar.gz", None),
            asset("openal_1.0-1.debian.tar.xz", None),
            asset("openal_1.0-1.dsc", None),
        ],
    );
    for (platform, expected) in [
        (Platform::WindowsX86_64, "r48"),
        (Platform::LinuxX86_64, "r55"),
    ] {
        let (root, _, server) = serve_http(vec![
            metadata(),
            releases(&[linux.clone(), windows.clone()]),
        ]);
        let result = GithubReleaseProvider::with_api_root(root)
            .unwrap()
            .resolve(&port, ReleaseChannel::Beta, platform)
            .await
            .unwrap();
        assert_eq!(result.version, expected);
        server.join().unwrap();
    }
    let stable = release("r38", vec![asset("Game-hd-r38-windows-x64.zip", Some('c'))]);
    let (root, _, server) = serve_http(vec![metadata(), releases(&[linux, stable])]);
    let result = GithubReleaseProvider::with_api_root(root)
        .unwrap()
        .resolve(&port, ReleaseChannel::Beta, Platform::WindowsX86_64)
        .await
        .unwrap();
    assert_eq!(result.version, "r38");
    assert_eq!(result.channel, ReleaseChannel::Beta);
    server.join().unwrap();
}

#[tokio::test]
async fn native_platform_streams_keep_uncertain_and_same_os_failures_authoritative() {
    let port = asymmetric_native_port();
    let old = preview("r1", vec![asset("Game-hd-r1-windows-x64.zip", Some('a'))]);
    for name in [
        "Game-hd-r2-windows-arm64.zip",
        "Game-standard-r2-windows-x64.zip",
        "Game-hd-r2-windows-x64.msi",
        "Game-hd-r2-windows-x64.tar.zst",
        "Game-hd-r2-windows-x64-debug.zip",
        "Game-hd-r2-windows-linux-x64.zip",
        "Game-hd-r2.zip",
    ] {
        let (root, _, server) = serve_http(vec![
            metadata(),
            releases(&[
                preview(
                    "r2",
                    vec![
                        asset("Game-hd-r2-linux-x64.tar.gz", Some('b')),
                        asset(name, Some('c')),
                    ],
                ),
                old.clone(),
            ]),
        ]);
        let failure = GithubReleaseProvider::with_api_root(root)
            .unwrap()
            .resolve(&port, ReleaseChannel::Beta, Platform::WindowsX86_64)
            .await
            .unwrap_err();
        assert_eq!(failure.code, crate::ErrorCode::NotFound, "{name}");
        server.join().unwrap();
    }
    for assets in [
        vec![],
        vec![asset("Game-hd-source-linux-x64.tar.gz", Some('b'))],
    ] {
        let (root, _, server) = serve_http(vec![
            metadata(),
            releases(&[preview("r2", assets), old.clone()]),
        ]);
        assert_eq!(
            GithubReleaseProvider::with_api_root(root)
                .unwrap()
                .resolve(&port, ReleaseChannel::Beta, Platform::WindowsX86_64)
                .await
                .unwrap_err()
                .code,
            crate::ErrorCode::NotFound
        );
        server.join().unwrap();
    }
    let reviewed = "Game-hd-r2-windows-x64-debug.zip";
    let mut debug = port.clone();
    debug
        .release
        .asset_hints
        .insert(Platform::WindowsX86_64, vec![reviewed.into()]);
    let (root, _, server) = serve_http(vec![
        metadata(),
        releases(&[
            preview(
                "r2",
                vec![
                    asset("Game-hd-r2-linux-x64.tar.gz", Some('b')),
                    asset(reviewed, Some('c')),
                ],
            ),
            old,
        ]),
    ]);
    let result = GithubReleaseProvider::with_api_root(root)
        .unwrap()
        .resolve(&debug, ReleaseChannel::Beta, Platform::WindowsX86_64)
        .await
        .unwrap();
    assert_eq!(result.version, "r2");
    assert_eq!(result.asset.name, reviewed);
    server.join().unwrap();
}

#[tokio::test]
async fn native_platform_cache_expiry_does_not_hide_a_new_same_os_refusal() {
    let port = asymmetric_native_port();
    let old = preview("r1", vec![asset("Game-hd-r1-windows-x64.zip", Some('a'))]);
    let (root, _, server) = serve_http(vec![
        metadata(),
        releases(std::slice::from_ref(&old)),
        metadata(),
        releases(&[
            preview(
                "r2",
                vec![
                    asset("Game-hd-r2-linux-x64.tar.gz", Some('b')),
                    asset("Game-hd-r2-windows-arm64.zip", Some('c')),
                ],
            ),
            old,
        ]),
    ]);
    let provider = GithubReleaseProvider::with_api_root(root).unwrap();
    assert_eq!(
        provider
            .resolve(&port, ReleaseChannel::Beta, Platform::WindowsX86_64)
            .await
            .unwrap()
            .version,
        "r1"
    );
    for entry in provider.cache.write().await.values_mut() {
        entry.stored_at = Instant::now() - RELEASE_CACHE_TTL - Duration::from_secs(1);
    }
    assert_eq!(
        provider
            .resolve(&port, ReleaseChannel::Beta, Platform::WindowsX86_64)
            .await
            .unwrap_err()
            .code,
        crate::ErrorCode::NotFound
    );
    server.join().unwrap();
}

#[tokio::test]
async fn reflectionhle_shared_release_keeps_all_nine_identities_dynamic_and_refuses_unsafe_assets()
{
    let catalog = crate::Catalog::embedded().unwrap();
    for id in [
        "keen-dreams-reflectionhle",
        "catacomb-3-d-the-descent-reflectionhle",
        "the-catacomb-abyss-reflectionhle",
        "the-catacomb-armageddon-reflectionhle",
        "the-catacomb-apocalypse-reflectionhle",
        "wolfenstein-3d-reflectionhle",
        "spear-of-destiny-reflectionhle",
        "super-3-d-noah-s-ark-dos-reflectionhle",
        "bio-menace-reflectionhle",
    ] {
        let port = catalog.port(id).unwrap();
        let definition = serde_json::to_vec(port).unwrap();
        let mut current = asset("reflectionhle-win64-20260606.zip", None);
        current["digest"] =
            "sha256:800e33a38f2b3986f6d0fdbbc67f527c6dc6b54e5949d1e0b02394377bdca3db".into();
        current["size"] = 7_448_866_u64.into();
        let observed = release(
            "release-20260606",
            vec![
                current.clone(),
                asset("reflectionhle-win32-20260606.zip", Some('b')),
                asset("reflectionhle-source-20260606.zip", Some('c')),
            ],
        );
        // Future metadata is controlled synthetic evidence, not an observed release.
        let successor = release(
            "release-20990101",
            vec![asset("reflectionhle-win64-20990101.zip", Some('d'))],
        );
        let (root, requests, server) = serve_http(vec![
            metadata(),
            releases(std::slice::from_ref(&observed)),
            metadata(),
            releases(&[successor, observed]),
        ]);
        let before = GithubReleaseProvider::with_api_root(root.clone())
            .unwrap()
            .resolve(port, ReleaseChannel::Stable, Platform::WindowsX86_64)
            .await
            .unwrap();
        let after = GithubReleaseProvider::with_api_root(root)
            .unwrap()
            .resolve(port, ReleaseChannel::Stable, Platform::WindowsX86_64)
            .await
            .unwrap();
        assert_eq!(before.version, "release-20260606");
        assert_eq!(before.asset.name, "reflectionhle-win64-20260606.zip");
        assert_eq!(before.asset.size, 7_448_866);
        assert_eq!(
            before.asset.sha256,
            "800e33a38f2b3986f6d0fdbbc67f527c6dc6b54e5949d1e0b02394377bdca3db"
        );
        assert_eq!(after.version, "release-20990101");
        assert_eq!(after.asset.name, "reflectionhle-win64-20990101.zip");
        assert_eq!(after.asset.sha256, "d".repeat(64));
        assert_eq!(serde_json::to_vec(port).unwrap(), definition);
        server.join().unwrap();
        assert_eq!(requests.try_iter().count(), 4);
        for mutation in ["wrong-cpu", "debug", "ambiguous", "missing-integrity"] {
            let mut player = current.clone();
            match mutation {
                "wrong-cpu" => player["name"] = "reflectionhle-win-arm64-20260606.zip".into(),
                "debug" => player["name"] = "reflectionhle-win64-debug-20260606.zip".into(),
                "missing-integrity" => player["digest"] = serde_json::Value::Null,
                _ => {}
            }
            let mut assets = vec![player];
            if mutation == "ambiguous" {
                assets.push(asset(
                    "reflectionhle-win64-alternate-20260606.zip",
                    Some('e'),
                ));
            }
            let (root, _, server) = serve_http(vec![
                metadata(),
                releases(&[release("release-20260606", assets)]),
            ]);
            let error = GithubReleaseProvider::with_api_root(root)
                .unwrap()
                .resolve(port, ReleaseChannel::Stable, Platform::WindowsX86_64)
                .await
                .unwrap_err();
            assert_eq!(
                error.code,
                match mutation {
                    "ambiguous" => crate::ErrorCode::Conflict,
                    "missing-integrity" => crate::ErrorCode::Verification,
                    _ => crate::ErrorCode::NotFound,
                },
                "{id}: {mutation}"
            );
            server.join().unwrap();
        }
    }
}

#[tokio::test]
async fn retained_releases_expose_old_filename_pins_without_guessing_a_successor() {
    // Independently retained provider metadata, replayed through production resolution.
    let observations = observed_rollout_releases("road-rash-64-recompiled");
    let mut port = crate::Catalog::embedded()
        .unwrap()
        .port("road-rash-64-recompiled")
        .unwrap()
        .clone();
    let old = &observations[1];
    let old_tag = old["tag_name"].as_str().unwrap();
    assert_ne!(observations[0]["tag_name"], old["tag_name"]);
    port.release.asset_hints.insert(
        Platform::WindowsX86_64,
        vec![old_tag.into(), "Win64.zip".into()],
    );
    let definition = serde_json::to_vec(&port).unwrap();
    let (root, _, server) = serve_http(vec![
        metadata(),
        releases(std::slice::from_ref(old)),
        metadata(),
        releases(&observations),
    ]);
    let original = GithubReleaseProvider::with_api_root(root.clone())
        .unwrap()
        .resolve(&port, ReleaseChannel::Stable, Platform::WindowsX86_64)
        .await
        .unwrap();
    assert_eq!(original.version, old_tag);
    let failure = GithubReleaseProvider::with_api_root(root)
        .unwrap()
        .resolve(&port, ReleaseChannel::Stable, Platform::WindowsX86_64)
        .await
        .unwrap_err();
    assert_eq!(failure.code, crate::ErrorCode::NotFound);
    assert_eq!(serde_json::to_vec(&port).unwrap(), definition);
    server.join().unwrap();
}

#[tokio::test]
async fn power_dozer_unchanged_definition_selects_windows_runtime_and_refuses_unsafe_variants_2557()
{
    let catalog = crate::Catalog::embedded().unwrap();
    let port = catalog.port("blast-corps-power-dozer").unwrap();
    let definition = serde_json::to_value(port).unwrap();
    let captured: serde_json::Value = serde_json::from_str(include_str!(
        "../../testdata/blast-corps-release-selection-2026-10-31.json"
    ))
    .unwrap();
    let observed = &captured["release"];
    let name = "power-dozer-v0.84-windows-x86_64.zip";
    let selected = observed["assets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|asset| asset["name"] == name)
        .unwrap();
    let mut next = observed.clone();
    next["tag_name"] = serde_json::json!("v0.85");
    for asset in next["assets"].as_array_mut().unwrap() {
        let name = asset["name"].as_str().unwrap().replace("v0.84", "v0.85");
        asset["name"] = serde_json::json!(name);
        asset["browser_download_url"] =
            serde_json::json!(format!("https://downloads.example.invalid/{name}"));
        asset["digest"] = serde_json::json!(format!("sha256:{}", "b".repeat(64)));
    }
    let (root, requests, server) = serve_http(vec![
        metadata(),
        releases(std::slice::from_ref(observed)),
        metadata(),
        releases(&[next]),
    ]);
    let old = GithubReleaseProvider::with_api_root(root.clone())
        .unwrap()
        .resolve(port, ReleaseChannel::Stable, Platform::WindowsX86_64)
        .await
        .unwrap();
    assert_eq!(old.version, "v0.84");
    assert_eq!(old.asset.name, name);
    assert_eq!(old.asset.size, 14_232_529);
    assert_eq!(
        old.asset.sha256,
        "5b25d339376065442d82972917c921fa25f3b9e2f5bb87252389a993a4723533"
    );
    let next = GithubReleaseProvider::with_api_root(root)
        .unwrap()
        .resolve(port, ReleaseChannel::Stable, Platform::WindowsX86_64)
        .await
        .unwrap();
    assert_eq!(next.version, "v0.85");
    assert_eq!(next.asset.name, "power-dozer-v0.85-windows-x86_64.zip");
    assert_eq!(next.asset.sha256, "b".repeat(64));
    server.join().unwrap();
    assert_eq!(requests.try_iter().count(), 4);
    for mutation in [
        "wrong-cpu",
        "wrong-platform",
        "ambiguous",
        "missing-integrity",
    ] {
        let mut player = selected.clone();
        match mutation {
            "wrong-cpu" => {
                player["name"] = serde_json::json!("power-dozer-v0.85-windows-arm64.zip")
            }
            "wrong-platform" => {
                player["name"] = serde_json::json!("power-dozer-v0.85-linux-x86_64.zip")
            }
            "missing-integrity" => player["digest"] = serde_json::Value::Null,
            _ => {}
        }
        let mut candidates = vec![player.clone()];
        if mutation == "ambiguous" {
            player["name"] = serde_json::json!("power-dozer-v0.85-alternate-windows-x86_64.zip");
            candidates.push(player);
        }
        let (root, _, server) =
            serve_http(vec![metadata(), releases(&[release("v0.85", candidates)])]);
        let error = GithubReleaseProvider::with_api_root(root)
            .unwrap()
            .resolve(port, ReleaseChannel::Stable, Platform::WindowsX86_64)
            .await
            .unwrap_err();
        assert_eq!(
            error.code,
            match mutation {
                "ambiguous" => crate::ErrorCode::Conflict,
                "missing-integrity" => crate::ErrorCode::Verification,
                _ => crate::ErrorCode::NotFound,
            },
            "{mutation}"
        );
        server.join().unwrap();
    }
    assert_eq!(serde_json::to_value(port).unwrap(), definition);
}

// Observed complete release metadata; all successors/refusals are controlled
// provider fixtures and do not inherit original, native or save qualification.
async fn assert_native_engine_adoption_selection(id: &str) {
    let corpus: serde_json::Value = serde_json::from_str(include_str!(
        "../../testdata/native-engine-adoption-2026-11-02.json"
    ))
    .unwrap();
    let case = corpus["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["port_id"] == id)
        .unwrap();
    let catalog = crate::Catalog::embedded().unwrap();
    let port = catalog.port(id).unwrap();
    let definition = serde_json::to_value(port).unwrap();
    let channel = if case["channel"] == "rolling" {
        ReleaseChannel::Rolling
    } else {
        ReleaseChannel::Stable
    };
    assert!(port.channels.contains(&channel), "{id}");
    let observed = &case["release"];
    let name = case["selected_asset"].as_str().unwrap();
    let scenarios: serde_json::Value = serde_json::from_str(include_str!(
        "../../testdata/native-engine-release-scenarios.json"
    ))
    .unwrap();
    let scenario = &scenarios[case["repository"].as_str().unwrap()];
    let player_scenario = &scenario["players"][name];
    let selected = observed["assets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|asset| asset["name"] == name)
        .unwrap();
    let mut successor = observed.clone();
    let original_tag = observed["tag_name"].as_str().unwrap();
    let next_tag = scenario["successor_tag"].as_str().unwrap();
    successor["tag_name"] = serde_json::json!(next_tag);
    let assets = successor["assets"].as_array_mut().unwrap();
    let next_names = scenario["successor_asset_names"].as_array().unwrap();
    assert_eq!(
        assets.len(),
        next_names.len(),
        "{id}: complete successor inventory"
    );
    for (asset, next) in assets.iter_mut().zip(next_names) {
        let next = next.as_str().unwrap();
        asset["name"] = serde_json::json!(next);
        asset["browser_download_url"] =
            serde_json::json!(format!("https://downloads.example.invalid/{next}"));
        asset["digest"] = serde_json::json!(format!("sha256:{}", "b".repeat(64)));
    }
    let (root, requests, server) = serve_http(vec![
        metadata(),
        releases(std::slice::from_ref(observed)),
        metadata(),
        releases(&[successor]),
    ]);
    let baseline = GithubReleaseProvider::with_api_root(root.clone())
        .unwrap()
        .resolve(port, channel, Platform::WindowsX86_64)
        .await
        .unwrap();
    assert_eq!(baseline.version, original_tag, "{id}");
    assert_eq!(baseline.asset.name, name, "{id}");
    assert_eq!(
        baseline.asset.size,
        selected["size"].as_u64().unwrap(),
        "{id}"
    );
    assert_eq!(
        baseline.asset.sha256,
        case["archive_sha256"].as_str().unwrap(),
        "{id}"
    );
    let next = GithubReleaseProvider::with_api_root(root)
        .unwrap()
        .resolve(port, channel, Platform::WindowsX86_64)
        .await
        .unwrap();
    assert_eq!(next.version, next_tag, "{id}");
    assert_eq!(
        next.asset.name,
        player_scenario["successor_asset"].as_str().unwrap(),
        "{id}"
    );
    assert_eq!(next.asset.sha256, "b".repeat(64), "{id}");
    assert_ne!(
        next.asset.sha256, baseline.asset.sha256,
        "{id}: rebuilt tags bind changed bytes"
    );
    server.join().unwrap();
    assert_eq!(requests.try_iter().count(), 4, "{id}");
    for mutation in [
        "wrong-cpu",
        "wrong-platform",
        "ambiguous",
        "missing-integrity",
    ] {
        let mut player = selected.clone();
        let original_name = player["name"].as_str().unwrap().to_owned();
        let mutated = match mutation {
            "wrong-cpu" => player_scenario["wrong_cpu"].as_str().unwrap(),
            "wrong-platform" => player_scenario["wrong_platform"].as_str().unwrap(),
            _ => &original_name,
        };
        player["name"] = serde_json::json!(mutated);
        if mutation == "missing-integrity" {
            player["digest"] = serde_json::Value::Null;
        }
        let mut assets = vec![player.clone()];
        if mutation == "ambiguous" {
            player["id"] = serde_json::json!(999_999_999);
            let ambiguous = player_scenario["ambiguous_asset"].as_str().unwrap();
            player["name"] = serde_json::json!(ambiguous);
            player["browser_download_url"] =
                serde_json::json!(format!("https://downloads.example.invalid/{ambiguous}"));
            assets.push(player);
        }
        let (root, _, server) =
            serve_http(vec![metadata(), releases(&[release(original_tag, assets)])]);
        let failure = GithubReleaseProvider::with_api_root(root)
            .unwrap()
            .resolve(port, channel, Platform::WindowsX86_64)
            .await
            .unwrap_err();
        assert_eq!(
            failure.code,
            match mutation {
                "ambiguous" => crate::ErrorCode::Conflict,
                "missing-integrity" => crate::ErrorCode::Verification,
                _ => crate::ErrorCode::NotFound,
            },
            "{id}: {mutation}"
        );
        server.join().unwrap();
    }
    assert_eq!(
        serde_json::to_value(port).unwrap(),
        definition,
        "{id}: provider observations grant no qualification"
    );
}

#[tokio::test]
async fn native_engine_selection_1878() {
    assert_native_engine_adoption_selection("sdlpal-sdlpal").await;
}

#[tokio::test]
async fn native_engine_selection_2567() {
    assert_native_engine_adoption_selection("doom-3-classic-dhewm3").await;
}

#[tokio::test]
async fn native_engine_selection_2568() {
    assert_native_engine_adoption_selection("doom-3-resurrection-of-evil-classic-dhewm3").await;
}

#[tokio::test]
async fn native_engine_selection_2565() {
    assert_native_engine_adoption_selection(
        "doom-3-classic-dude-doom-3-unified-development-engine",
    )
    .await;
}

#[tokio::test]
async fn native_engine_selection_2566() {
    assert_native_engine_adoption_selection(
        "doom-3-resurrection-of-evil-classic-dude-doom-3-unified-development-engine",
    )
    .await;
}

#[tokio::test]
async fn native_engine_selection_2592() {
    assert_native_engine_adoption_selection("medal-of-honor-allied-assault-openmohaa").await;
}

#[tokio::test]
async fn native_engine_selection_2593() {
    assert_native_engine_adoption_selection("medal-of-honor-allied-assault-spearhead-openmohaa")
        .await;
}

#[tokio::test]
async fn native_engine_selection_2594() {
    assert_native_engine_adoption_selection("medal-of-honor-allied-assault-breakthrough-openmohaa")
        .await;
}

#[tokio::test]
async fn native_engine_selection_2611() {
    assert_native_engine_adoption_selection(
        "star-wars-jedi-knight-ii-jedi-outcast-single-player-openjk-openjo",
    )
    .await;
}

#[tokio::test]
async fn native_engine_selection_2612() {
    assert_native_engine_adoption_selection(
        "star-wars-jedi-knight-jedi-academy-single-player-and-multiplayer-openjk-openjo",
    )
    .await;
}

#[derive(serde::Deserialize)]
struct ManagedPsxArchiveExpectation {
    serial: String,
    revision: Option<String>,
    track_count: u32,
    track_sha1: String,
    track_sha256: Option<String>,
    generated_executable: String,
    #[serde(default)]
    openbios: bool,
    bios_profile: Option<String>,
    #[serde(default)]
    crash_diagnostic: bool,
    #[serde(default)]
    split_mod_paths: bool,
    /// The observed release ran with the kit's bundled OpenBIOS. Its game
    /// evidence stays exact, but the retail BIOS contract is bound only to
    /// the later reviewed kits that require that BIOS.
    #[serde(default)]
    retail_bios_from_later_release: bool,
    #[serde(default)]
    extra_persistent_paths: Vec<String>,
}

impl ManagedPsxArchiveExpectation {
    fn assert_contract(
        &self,
        catalog: &crate::Catalog,
        port: &crate::PortDefinition,
        platform: Platform,
        version: &str,
        artifact_sha256: &str,
        observed_release: bool,
    ) {
        let id = &port.id;
        let source_catalog = catalog.source_catalog().unwrap();
        let bios_id = self
            .bios_profile
            .as_deref()
            .or((!self.openbios).then_some("psx-scph-1001-bios"));
        assert!(
            !self.retail_bios_from_later_release || (self.bios_profile.is_some() && !self.openbios),
            "{id}: a later retail BIOS binding needs an explicit retail profile"
        );
        assert_eq!(port.adapter, crate::AdapterKind::PsxRecompManaged, "{id}");
        assert_eq!(port.bios_source_profile.as_deref(), bios_id, "{id}");
        let executable = match platform {
            Platform::LinuxX86_64 => self.generated_executable.strip_suffix(".exe").unwrap(),
            _ => &self.generated_executable,
        };
        assert_eq!(
            port.executable_hints[&platform],
            [executable],
            "{id}: {platform:?} generated player"
        );
        assert_eq!(
            port.runtime_subdirectory.as_deref(),
            Some("build-portcove"),
            "{id}"
        );
        let arguments = if self.openbios {
            ["--no-launcher", "--bios", "bios/openbios.bin"].as_slice()
        } else {
            ["--no-launcher"].as_slice()
        };
        assert_eq!(port.launch_arguments, arguments, "{id}");
        for owned in [
            "saves",
            "settings.toml",
            "bios.cfg",
            "disc.cfg",
            "overlay-captures",
        ]
        .into_iter()
        .chain(self.extra_persistent_paths.iter().map(String::as_str))
        {
            assert!(
                port.persistent_paths.iter().any(|path| path == owned),
                "{id}: {owned}"
            );
            assert!(
                !port.runtime_mutable_paths.iter().any(|path| path == owned),
                "{id}: {owned}"
            );
        }
        if self.crash_diagnostic {
            assert!(
                port.runtime_mutable_paths
                    .iter()
                    .any(|path| path == "psx_crash.txt"),
                "{id}: crash diagnostic"
            );
            assert!(
                !port
                    .persistent_paths
                    .iter()
                    .any(|path| path == "psx_crash.txt"),
                "{id}: crash diagnostic must not enter backups"
            );
        }
        if self.split_mod_paths {
            let is_mod_path = |path: &str| path == "mods" || path.starts_with("mods/");
            let actual: std::collections::BTreeSet<_> = port
                .persistent_paths
                .iter()
                .map(String::as_str)
                .filter(|path| is_mod_path(path))
                .collect();
            assert_eq!(
                actual,
                std::collections::BTreeSet::from([
                    "mods/.staging",
                    "mods/installed",
                    "mods/packages",
                    "mods/state.toml",
                    "mods/state.toml.tmp",
                    "mods/texture-packs",
                ]),
                "{id}: split player mod paths"
            );
            assert!(
                !port
                    .runtime_mutable_paths
                    .iter()
                    .any(|path| is_mod_path(path)),
                "{id}: bundled mods must remain verified runtime files"
            );
        }
        let profile_id = port.source_profile.as_deref().unwrap();
        let profile = source_catalog
            .identities
            .iter()
            .find(|profile| profile.id == profile_id)
            .unwrap();
        let [variant] = profile.variants.as_slice() else {
            panic!("{id}: expected one original variant")
        };
        assert_eq!(variant.product_codes, [self.serial.as_str()], "{id}");
        assert_eq!(variant.revision, self.revision, "{id}");
        let [representation] = variant.representations.as_slice() else {
            panic!("{id}: expected one original representation")
        };
        assert_eq!(representation.extensions, ["chd"], "{id}");
        let crate::SourceRepresentationKind::OpticalTrackSet {
            track_counts,
            identities,
        } = &representation.kind
        else {
            panic!("{id}: expected an optical track set")
        };
        assert_eq!(track_counts, &[self.track_count], "{id}");
        let [track] = identities.as_slice() else {
            panic!("{id}: expected one track identity")
        };
        assert_eq!(
            track.sha1.as_deref(),
            Some(self.track_sha1.as_str()),
            "{id}"
        );
        assert_eq!(
            track.sha256.as_deref(),
            self.track_sha256.as_deref(),
            "{id}"
        );
        let requirements = [
            (crate::PortSourceRole::Game, Some(profile_id)),
            (crate::PortSourceRole::Bios, bios_id),
        ];
        for (role, expected_profile) in requirements {
            let contract = source_catalog
                .contracts
                .iter()
                .find(|contract| contract.port_id == *id && contract.role == role);
            let Some(expected_profile) = expected_profile else {
                assert!(
                    contract.is_none(),
                    "{id}: unexpected {role:?} source contract"
                );
                continue;
            };
            let contract = contract.unwrap();
            assert_eq!(contract.profile_id, expected_profile, "{id}: {role:?}");
            assert_eq!(
                contract.admission_mode,
                crate::CatalogAdmissionMode::Enforced,
                "{id}: {role:?}"
            );
            assert_eq!(contract.release_policy, None, "{id}: {role:?}");
            let bound = observed_release
                && !(role == crate::PortSourceRole::Bios && self.retail_bios_from_later_release);
            assert_eq!(
                contract.applies_to_release(version, artifact_sha256),
                bound,
                "{id}: exact source evidence for {role:?} on {version}"
            );
        }
    }
}

#[tokio::test]
async fn portable_engine_linux_siblings_select_player_archives() {
    let catalog = crate::Catalog::embedded().unwrap();
    let cases = [
        (
            "gunstar-heroes-gunstars",
            "v0.2.2",
            "gunstars-0.2.2-linux-x64.tar.gz",
            "gunstars-0.2.2-windows-x64.zip",
            "gunstars-0.2.2-macos-universal.zip",
            "gunstar",
        ),
        (
            "vyruz-destruction-of-the-untel-empire-openvyruz",
            "v1.1.0",
            "OpenVyruz-v1.1.0-linux-x64.tar.gz",
            "OpenVyruz-v1.1.0-windows-x64.zip",
            "SHA256SUMS.txt",
            "Vyruz",
        ),
        (
            "elraro-atomic-bomberman",
            "v1.0",
            "atomic-bomberman-modern-linux-x86_64.tar.gz",
            "atomic-bomberman-modern-windows-x64.zip",
            "atomic-bomberman-server-linux-x86_64.tar.gz",
            "atomic",
        ),
        (
            "atlantis-the-lost-tales-atlantis-native",
            "v0.6.0",
            "atlantis-native-linux-x64.tar.gz",
            "atlantis-native-windows-x64.zip",
            "atlantis-native-linux-arm64.tar.gz",
            "atlantis-native",
        ),
    ];
    for (id, tag, linux, windows, other, executable) in cases {
        let port = catalog.port(id).unwrap();
        assert_eq!(port.adapter, crate::AdapterKind::NativePortable, "{id}");
        assert_eq!(port.executable_hints[&Platform::LinuxX86_64], [executable]);
        let observed = [release(
            tag,
            vec![
                asset(other, Some('a')),
                asset(windows, Some('b')),
                asset(linux, Some('c')),
            ],
        )];
        for (platform, name) in [
            (Platform::LinuxX86_64, linux),
            (Platform::WindowsX86_64, windows),
        ] {
            let (root, requests, server) = serve_http(vec![metadata(), releases(&observed)]);
            let selected = GithubReleaseProvider::with_api_root(root)
                .unwrap()
                .resolve(port, ReleaseChannel::Stable, platform)
                .await
                .unwrap();
            assert_eq!(selected.version, tag, "{id} on {platform:?}");
            assert_eq!(selected.asset.name, name, "{id} on {platform:?}");
            server.join().unwrap();
            assert_eq!(requests.try_iter().count(), 2, "{id}");
        }
    }
}

#[test]
fn native_linux_tar_xz_selection_keeps_the_windows_archive_and_cache_identity() {
    let catalog = crate::Catalog::embedded().unwrap();
    for (id, prefix) in [
        ("star-wars-x-wing-openxw", "openxw"),
        ("star-wars-x-wing-alliance-openxwa", "openxwa"),
        (
            "star-wars-x-wing-vs-tie-fighter-balance-of-power-openxvt",
            "openxvt",
        ),
    ] {
        let port = catalog.port(id).unwrap();
        let linux = Platform::LinuxX86_64;
        let windows = Platform::WindowsX86_64;
        assert!(port.release.requires_tar_xz(linux));
        let inventory = [
            format!("{prefix}-1.0-linux-x86_64-release.tar.xz"),
            format!("{prefix}-1.0-linux-x86_64-release.tar.xz.zip"),
            format!("{prefix}-1.0-linux-aarch64-release.tar.xz"),
            format!("{prefix}-1.0-windows-x86_64-release.zip"),
        ]
        .map(|name| serde_json::from_value::<GithubAsset>(asset(&name, Some('a'))).unwrap());
        assert_eq!(
            choose_asset(port, linux, &inventory).unwrap().name,
            inventory[0].name
        );
        assert!(choose_asset(port, linux, &inventory[1..]).is_err());
        assert_eq!(
            choose_asset(port, windows, &inventory).unwrap().name,
            inventory[3].name
        );

        let mut legacy = port.clone();
        legacy.release.linux_tar_xz = false;
        assert!(choose_asset(&legacy, linux, &inventory[..1]).is_err());
        assert_eq!(
            ReleaseSelectionCacheKey::new(port, ReleaseChannel::Stable, windows),
            ReleaseSelectionCacheKey::new(&legacy, ReleaseChannel::Stable, windows)
        );
        assert_ne!(
            ReleaseSelectionCacheKey::new(port, ReleaseChannel::Stable, linux),
            ReleaseSelectionCacheKey::new(&legacy, ReleaseChannel::Stable, linux)
        );
    }
}

#[tokio::test]
async fn windows_archive_selection_advances_from_shared_release_inventories() {
    #[derive(serde::Deserialize)]
    struct Case {
        inventory: String,
        repository_id: Option<u64>,
        selected_assets: Vec<String>,
        #[serde(default)]
        linux_selected_assets: Vec<String>,
        #[serde(default)]
        macos_x86_64_selected_assets: Vec<String>,
        #[serde(default)]
        macos_aarch64_selected_assets: Vec<String>,
        channel: Option<ReleaseChannel>,
        #[serde(default)]
        mutable_tag_snapshots: bool,
        managed_psx: Option<ManagedPsxArchiveExpectation>,
    }

    #[derive(serde::Deserialize)]
    struct OtherZipAsset {
        inventory: String,
        release_index: usize,
        asset: String,
    }

    #[derive(serde::Deserialize)]
    struct Corpus {
        cases: std::collections::BTreeMap<String, Case>,
        inventories: std::collections::BTreeMap<String, Vec<serde_json::Value>>,
        other_zip_assets: Vec<OtherZipAsset>,
    }

    let catalog = crate::Catalog::embedded().unwrap();
    let Corpus {
        cases,
        inventories,
        other_zip_assets,
    } = serde_json::from_str(include_str!(
        "../../testdata/windows-archive-release-selection.json"
    ))
    .unwrap();
    assert!(!cases.is_empty());
    let mut enrolled = std::collections::BTreeSet::new();
    let mut selected_zips = std::collections::BTreeSet::new();
    for (id, case) in cases {
        let port = catalog.port(&id).unwrap();
        assert_eq!(
            case.managed_psx.is_some(),
            port.adapter == crate::AdapterKind::PsxRecompManaged,
            "{id}: managed PSX expectation enrollment"
        );
        let channel = case.channel.unwrap_or(ReleaseChannel::Stable);
        assert!(port.channels.contains(&channel), "{id}: enrolled channel");
        if case.mutable_tag_snapshots {
            assert_eq!(channel, ReleaseChannel::Rolling);
            assert!(port.release.rolling_tag.is_some());
        }
        let definition = serde_json::to_value(port).unwrap();
        let observed = &inventories[&case.inventory];
        assert!(observed.len() >= 2, "{id}");
        assert_eq!(observed.len(), case.selected_assets.len(), "{id}");
        let platforms = [
            (Platform::WindowsX86_64, case.selected_assets),
            (Platform::LinuxX86_64, case.linux_selected_assets),
            (Platform::MacosX86_64, case.macos_x86_64_selected_assets),
            (Platform::MacosAarch64, case.macos_aarch64_selected_assets),
        ];
        for (platform, names) in platforms {
            if names.is_empty() {
                continue;
            }
            assert_eq!(observed.len(), names.len(), "{id} on {platform:?}");
            for (index, name) in names.iter().enumerate() {
                let release = &observed[index];
                let tag = release["tag_name"].as_str().unwrap();
                let expected = release["assets"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|asset| asset["name"].as_str() == Some(name))
                    .unwrap();
                assert!(
                    enrolled.insert((id.clone(), platform, index)),
                    "{id}: duplicate release selection enrollment at {index}"
                );
                if name.ends_with(".zip") {
                    selected_zips.insert((case.inventory.clone(), index, name.clone()));
                }
                // A rolling tag's later observation replaces its previous snapshot.
                // Stable releases remain visible together in the upstream inventory.
                let first = if case.mutable_tag_snapshots { index } else { 0 };
                let visible = observed[first..=index]
                    .iter()
                    .rev()
                    .cloned()
                    .collect::<Vec<_>>();
                let repository = match case.repository_id {
                    Some(id) => ok_json(
                        &serde_json::json!({"id":id,"archived":false}).to_string(),
                        "",
                    ),
                    None => metadata(),
                };
                let (root, requests, server) = serve_http(vec![repository, releases(&visible)]);
                let selected = GithubReleaseProvider::with_api_root(root)
                    .unwrap()
                    .resolve(port, channel, platform)
                    .await
                    .unwrap();
                assert_eq!(selected.version, tag, "{id}");
                assert_eq!(&selected.asset.name, name, "{id}");
                assert_eq!(
                    selected.asset.size,
                    expected["size"].as_u64().unwrap(),
                    "{id}"
                );
                assert_eq!(
                    selected.asset.sha256,
                    expected["digest"]
                        .as_str()
                        .unwrap()
                        .strip_prefix("sha256:")
                        .unwrap(),
                    "{id}"
                );
                if let Some(contract) = &case.managed_psx {
                    contract.assert_contract(
                        &catalog,
                        port,
                        platform,
                        &selected.version,
                        &selected.asset.sha256,
                        index == 0,
                    );
                }
                server.join().unwrap();
                assert_eq!(requests.try_iter().count(), 2, "{id}");
            }
        }
        assert_eq!(serde_json::to_value(port).unwrap(), definition, "{id}");
    }
    let mut other_zips = std::collections::BTreeSet::new();
    for asset in other_zip_assets {
        assert!(other_zips.insert((asset.inventory, asset.release_index, asset.asset)));
    }
    for (group, observed) in inventories {
        for (index, release) in observed.iter().enumerate() {
            for asset in release["assets"].as_array().unwrap() {
                let name = asset["name"].as_str().unwrap();
                if name.ends_with(".zip") {
                    let key = (group.clone(), index, name.to_owned());
                    assert!(
                        selected_zips.remove(&key) ^ other_zips.remove(&key),
                        "{key:?}"
                    );
                }
            }
        }
    }
    assert!(
        selected_zips.is_empty(),
        "unmatched selected ZIPs: {selected_zips:?}"
    );
    assert!(
        other_zips.is_empty(),
        "unmatched other ZIPs: {other_zips:?}"
    );
}
