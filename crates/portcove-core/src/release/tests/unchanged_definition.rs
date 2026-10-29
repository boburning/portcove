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
