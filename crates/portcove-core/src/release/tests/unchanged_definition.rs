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
async fn unchanged_live_and_frozen_proposed_rules_follow_versioned_packages_after_cache_expiry_and_on_fresh_install()
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
    ] {
        // Adopted portable and original-driven routes use their shipped rules.
        // Sonic3K stays a frozen proposal pending its separate data transition.
        let proposed;
        let port = if matches!(
            id,
            "alariq-mc2"
                | "battletanx-global-assault-pc-port"
                | "brawmario-infinite-mario-64-ever"
                | "dkc1-recomp"
                | "f-zero-snes-recomp"
                | "dkc3-recomp"
                | "super-mario-world-recomp"
                | "the-legend-of-zelda-a-link-to-the-past-snes-recomp"
                | "sonic-the-hedgehog-2-recomp"
                | "super-bomberman-recomp"
        ) {
            catalog.port(id).unwrap()
        } else {
            proposed = crate::test_fixture::proposed_rollout_port(id);
            &proposed
        };
        let old = release(old_tag, vec![asset(old_name, Some('a'))]);
        let new = release(
            new_tag,
            vec![
                asset(new_name, Some('b')),
                asset(
                    &new_name
                        .replace("windows", "linux")
                        .replace("Windows", "Linux")
                        .replace("win64", "linux64"),
                    Some('c'),
                ),
                asset(
                    &new_name
                        .replace("x64", "arm64")
                        .replace("win64", "win-arm64")
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
async fn unchanged_beta_staged_rules_follow_player_successors_and_skip_compliance_archives() {
    let catalog = crate::Catalog::embedded().unwrap();
    // Both successors are controlled fixtures, not published upstream releases.
    for (id, old_tag, old_name, new_tag, new_name) in [
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
    ] {
        let port = catalog.port(id).unwrap();
        let mut old = release(old_tag, vec![asset(old_name, Some('a'))]);
        old["prerelease"] = true.into();
        let mut next = release(
            new_tag,
            vec![
                asset(new_name, Some('b')),
                asset(&new_name.replace(".zip", "-LGPL-Compliance.zip"), Some('c')),
                asset(&new_name.replace(".zip", "-arm64.zip"), Some('d')),
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
    ] {
        let mut port = variant_port();
        port.adapter = adapter;
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
        releases(&[current.clone()]),
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
