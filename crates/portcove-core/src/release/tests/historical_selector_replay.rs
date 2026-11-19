//! Historical provider payloads replayed through Core's selectors.
//! Test-only port rules exercise selection. They confer no package authority.
use super::*;
use serde_json::Value;

fn historical_observation(project: &str) -> Value {
    let corpus: Value = serde_json::from_str(include_str!(
        "../../testdata/historical-selector-replay.json"
    ))
    .unwrap();
    corpus[project].clone()
}

fn windows_archive_case(repository: &str) -> PortDefinition {
    let catalog = crate::Catalog::embedded().unwrap();
    let mut port = catalog.port("diablo-devilutionx").unwrap().clone();
    port.release.repository = repository.into();
    port.release.asset_hints.clear();
    port
}

async fn observe_release(
    repository: &Value,
    inventory: &[Value],
    port: &PortDefinition,
    channel: ReleaseChannel,
    platform: Platform,
) -> Result<ResolvedRelease> {
    let response = ok_json(&repository.to_string(), "");
    let (root, requests, server) = serve_http(vec![response, releases(inventory)]);
    let result = GithubReleaseProvider::with_api_root(root)
        .unwrap()
        .resolve(port, channel, platform)
        .await;
    server.join().unwrap();
    assert_eq!(requests.try_iter().count(), 2);
    result
}

#[tokio::test]
async fn wario_land_4_linux_publication_does_not_displace_the_windows_beta() {
    // The two official release pages name the package for each target and its SHA-256:
    // https://github.com/BioRhythmicStudios/warioland4/releases/tag/v0.3.2-beta
    // https://github.com/BioRhythmicStudios/warioland4/releases/tag/linux-v0.1.0-beta
    // Quiver independently reproduced the regression in https://github.com/tgeorgiadis/quiver-launcher/pull/292.
    let observation = historical_observation("wario_land_4");
    let repository = &observation["repository"];
    let mut inventory = observation["releases"].as_array().unwrap().clone();
    let mut port = windows_archive_case("BioRhythmicStudios/warioland4");
    port.channels.push(ReleaseChannel::Beta);
    let windows = Platform::WindowsX86_64;
    let linux = Platform::LinuxX86_64;
    port.release.asset_hints.insert(
        windows,
        vec![
            "WarioLand4-Native-PC-Port-v".into(),
            "-beta-Windows-x64.zip".into(),
        ],
    );
    let linux_package = "Wario_Land_4-v0.1.0-beta-x86_64.AppImage";
    port.release
        .asset_hints
        .insert(linux, vec![linux_package.into()]);
    port.executable_hints
        .insert(linux, vec![linux_package.into()]);

    let previous = observe_release(
        repository,
        &inventory[2..],
        &port,
        ReleaseChannel::Beta,
        windows,
    )
    .await
    .unwrap();
    assert_eq!(previous.version, "v0.3.1-beta");
    assert_eq!(
        previous.asset.sha256,
        "c2a837e5c2d07055dd982ab3fd7e66fb0724561b7bbdf20d7b8752894f937164"
    );

    // All permutations of the package and checksum for each of the three releases.
    for reversed in 0..(1 << inventory.len()) {
        for (index, release) in inventory.iter_mut().enumerate() {
            // Use the original snapshot for every permutation.
            let mut assets = observation["releases"][index]["assets"]
                .as_array()
                .unwrap()
                .clone();
            assert_eq!(assets.len(), 2);
            if reversed & (1 << index) != 0 {
                assets.reverse();
            }
            release["assets"] = Value::Array(assets);
        }
        for (platform, tag, filename, digest) in [
            (
                windows,
                "v0.3.2-beta",
                "WarioLand4-Native-PC-Port-v0.3.2-beta-Windows-x64.zip",
                "b2d63930fa4eaacdeee25e0fdca497e8cc03d18a09fe7c08101ac3107357ce8f",
            ),
            (
                linux,
                "linux-v0.1.0-beta",
                linux_package,
                "c80bd54f8a9aa8a71c00149be607c61349da79346219f764ab8520efbb3cb7b2",
            ),
        ] {
            let selected = observe_release(
                repository,
                &inventory,
                &port,
                ReleaseChannel::Beta,
                platform,
            )
            .await
            .unwrap();
            assert_eq!(selected.version, tag);
            assert_eq!(selected.asset.name, filename);
            assert_eq!(selected.asset.sha256, digest);
        }
    }
    // The provider marks each release as stable even though its tag says beta.
    assert_eq!(
        observe_release(
            repository,
            &inventory,
            &port,
            ReleaseChannel::Stable,
            windows
        )
        .await
        .unwrap_err()
        .code,
        crate::ErrorCode::NotFound
    );

    let release: GithubRelease = serde_json::from_value(inventory[1].clone()).unwrap();
    let player = release
        .assets
        .iter()
        .find(|asset| asset.name == "WarioLand4-Native-PC-Port-v0.3.2-beta-Windows-x64.zip")
        .unwrap();
    for competitor in [
        "WarioLand4-Native-PC-Port-v0.3.2-beta-Linux-x86_64.AppImage",
        "WarioLand4-Native-PC-Port-v0.3.2-debug-beta-Windows-x64.zip",
        "WarioLand4-Native-PC-Port-v0.3.2-symbols-beta-Windows-x64.zip",
        "WarioLand4-Native-PC-Port-v0.3.2-source-beta-Windows-x64.zip",
        "WarioLand4-Native-PC-Port-v0.3.2-beta-Windows-arm64.zip",
        "WarioLand4-Native-PC-Port-v0.3.2-beta-Windows-x64.zip.sha256",
    ] {
        let candidate: GithubAsset = serde_json::from_value(asset(competitor, Some('a'))).unwrap();
        for assets in [
            [player.clone(), candidate.clone()],
            [candidate, player.clone()],
        ] {
            let selected = choose_asset(&port, windows, &assets).unwrap();
            assert_eq!(selected.id, player.id, "competitor: {competitor}");
        }
    }
    let mut second_client: GithubAsset = serde_json::from_value(asset(
        "WarioLand4-Native-PC-Port-v0.3.2-alternate-beta-Windows-x64.zip",
        Some('b'),
    ))
    .unwrap();
    second_client.id = Some(987_654_321);
    for assets in [
        [player.clone(), second_client.clone()],
        [second_client, player.clone()],
    ] {
        let error = choose_asset(&port, windows, &assets).unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Conflict);
    }
}

fn every_asset_order<T>(assets: &mut [T], cursor: usize, check: &mut impl FnMut(&[T])) {
    if cursor == assets.len() {
        check(assets);
        return;
    }
    for index in cursor..assets.len() {
        assets.swap(cursor, index);
        every_asset_order(assets, cursor + 1, check);
        assets.swap(cursor, index);
    }
}

#[test]
fn folklore_date_change_does_not_make_distinct_disc_requirements_interchangeable() {
    // RecompLauncher v0.90.0-beta.64 uses these dated names in its matcher tests.
    // Upstream's package instructions distinguish v1.00 disc and 1.10 update
    // workflows for BCUS98147 (North America) and BCES00050 (Europe).
    // https://github.com/Mava-b/folklore-decomp/releases/tag/v0.6
    // https://github.com/Mava-b/folklore-decomp/releases/tag/v0.62
    // https://github.com/Mava-b/folklore-decomp/blob/v0.62/README.md
    let observation = historical_observation("folklore");
    let platform = Platform::WindowsX86_64;
    let mut port = windows_archive_case("Mava-b/folklore-decomp");
    port.release
        .asset_hints
        .insert(platform, vec!["Folklore-".into()]);

    for (release, base) in observation["releases"]
        .as_array()
        .unwrap()
        .iter()
        .zip(["Folklore-20261108-1524", "Folklore-20261107-1109"])
    {
        let release: GithubRelease = serde_json::from_value(release.clone()).unwrap();
        let observed = release
            .assets
            .iter()
            .map(|asset| asset.name.clone())
            .collect::<std::collections::BTreeSet<_>>();
        let expected: std::collections::BTreeSet<_> =
            [".zip", "_1.10.zip", "_eu.zip", "_eu_1.10.zip"]
                .map(|variant| format!("{base}{variant}"))
                .into_iter()
                .collect();
        assert_eq!(observed, expected);
        let mut assets = release.assets;
        every_asset_order(&mut assets, 0, &mut |assets| {
            let error = choose_asset(&port, platform, assets).err().unwrap();
            assert_eq!(error.code, crate::ErrorCode::Conflict);
        });
    }
}

#[test]
fn tekken_tag_tournament_2_server_archives_are_not_game_packages() {
    // The upstream release notes identify ttt2_setup.exe as the client and
    // list the dedicated server packages separately, with individual digests.
    // https://github.com/shihabal3amri/tekken-tag-tournament-2-pc/releases/tag/v0.1.7
    // https://github.com/shihabal3amri/tekken-tag-tournament-2-pc/releases/tag/v0.2.0
    use crate::service::package_selection::assess_package_name;

    let observation = historical_observation("tekken_tag_tournament_2");
    let mut port = windows_archive_case("shihabal3amri/tekken-tag-tournament-2-pc");
    port.release
        .asset_hints
        .insert(Platform::WindowsX86_64, vec!["ttt2".into()]);
    for release in observation["releases"].as_array().unwrap() {
        let mut release: GithubRelease = serde_json::from_value(release.clone()).unwrap();
        assert_eq!(release.assets.len(), 4);
        every_asset_order(&mut release.assets, 0, &mut |assets| {
            // The client installer belongs to upstream's setup route. The
            // managed archive route must not substitute the server ZIP.
            let error = choose_asset(&port, Platform::WindowsX86_64, assets)
                .err()
                .unwrap();
            assert_eq!(error.code, crate::ErrorCode::NotFound);
            for (platform, expected) in [
                (Platform::WindowsX86_64, ["ttt2_setup.exe"].as_slice()),
                (Platform::LinuxX86_64, [].as_slice()),
            ] {
                let offered = assets
                    .iter()
                    .filter(|asset| {
                        let can_extract =
                            asset.name.ends_with(".zip") || asset.name.ends_with(".tar.gz");
                        assess_package_name(&asset.name, can_extract, platform, &["ttt2".into()])
                            .2
                            .is_some()
                    })
                    .map(|asset| asset.name.as_str())
                    .collect::<Vec<_>>();
                assert_eq!(offered, expected);
            }
        });
    }
}

#[test]
fn psx_recomp_consumer_refuses_another_games_build_for_the_same_target() {
    let catalog = crate::Catalog::embedded().unwrap();
    let port = catalog.port("alexbeav-incredible-crisis-recomp").unwrap();
    let fixture: Value = serde_json::from_str(include_str!(
        "../../testdata/windows-archive-release-selection.json"
    ))
    .unwrap();
    // Use the real v0.1.0 inventories, with a synthetic mixed upload to
    // exercise isolation against another PSXRecomp game's actual package.
    // https://github.com/alexbeavs-ps1-ports/incredible-crisis-recomp/releases/tag/v0.1.0
    // https://github.com/alexbeavs-ps1-ports/future-cop-lapd-recomp/releases/tag/v0.1.0
    let player: GithubRelease = serde_json::from_value(
        fixture["inventories"]["alexbeav-incredible-crisis-recomp"][0].clone(),
    )
    .unwrap();
    let sibling: GithubRelease = serde_json::from_value(
        fixture["inventories"]["alexbeav-future-cop-lapd-recomp"][0].clone(),
    )
    .unwrap();
    let expected = "incrediblecrisis-0.1.0-windows-x64.zip";
    let platform = Platform::WindowsX86_64;
    let sibling_package = sibling
        .assets
        .iter()
        .find(|asset| asset.name == "futurecoplapd-0.1.0-windows-x64.zip")
        .unwrap();
    assert!(choose_asset(port, platform, std::slice::from_ref(sibling_package)).is_err());
    let mut mixed = player.assets;
    mixed.push(sibling_package.clone());
    every_asset_order(&mut mixed, 0, &mut |assets| {
        let selected = choose_asset(port, platform, assets).unwrap();
        assert_eq!(selected.name, expected);
    });
}

#[test]
fn resident_evil_x64_server_does_not_replace_the_multilib_linux_client() {
    // Upstream identifies the i686 player, its multilib prerequisites, and the
    // independent x86-64 co-op server in the actual v0.8.0 release notes.
    // https://github.com/aikatore/recvx-enhanced-port/releases/tag/v0.8.0
    use crate::service::package_selection::assess_package_name;

    let observation = historical_observation("resident_evil_cv_x_enhanced");
    let mut release: GithubRelease =
        serde_json::from_value(observation["releases"][0].clone()).unwrap();
    let platform = Platform::LinuxX86_64;
    assert_eq!(release.assets.len(), 6);
    every_asset_order(&mut release.assets, 0, &mut |assets| {
        for asset in assets {
            let can_extract = crate::archive::can_extract_download_archive(&asset.name);
            let (suitability, _, score) =
                assess_package_name(&asset.name, can_extract, platform, &[]);
            assert!(score.is_none(), "unexpected native choice: {}", asset.name);
            match asset.id {
                Some(750950967) => assert_eq!(suitability, "auxiliary"),
                Some(750950969) => assert_eq!(suitability, "emulation"),
                _ => {}
            }
        }
    });
}

#[test]
fn gitlab_managed_client_targets_keep_their_linked_registry_artifacts() {
    // The pinned links and package-file IDs come from these upstream releases.
    // Intel and Apple silicon use the same reviewed universal macOS package.
    // https://gitlab.com/sonicdcer/DNZHRecomp/-/releases/0.0.3
    // https://gitlab.com/sonicdcer/ExtremeGRecomp/-/releases/v1.0.0
    let catalog = crate::Catalog::embedded().unwrap();
    let stable = |projection: &Value| {
        projection["projections"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|row| row["channel"] == "stable")
            .map(|row| (row["platform"].as_str().unwrap().to_owned(), row.clone()))
            .collect::<std::collections::BTreeMap<_, _>>()
    };
    for (id, fixture, recorded_ids) in [
        (
            "duke-nukem-zero-hour-recompiled",
            "gitlab_duke_nukem_zero_hour",
            [333736951, 333737109, 333737048, 333737048],
        ),
        (
            "extreme-g-recompiled",
            "gitlab_extreme_g",
            [338153139, 338153275, 338153222, 338153222],
        ),
    ] {
        let port = catalog.port(id).unwrap();
        let facts = historical_observation(fixture);
        let mut links = facts["releases"][0]["assets"]["links"]
            .as_array()
            .unwrap()
            .clone();
        let selected = stable(&crate::gitlab::project_observed_releases(port, &facts).unwrap());
        assert_eq!(selected.len(), 4);
        for (target, file_id) in [
            "windows-x86-64",
            "linux-x86-64",
            "macos-x86-64",
            "macos-aarch64",
        ]
        .into_iter()
        .zip(recorded_ids)
        {
            let expected = facts["package_files"]
                .as_object()
                .unwrap()
                .values()
                .flat_map(|files| files.as_array().unwrap())
                .find(|file| file["id"] == file_id)
                .unwrap();
            let eligible = &selected[target]["latest_eligible"];
            assert_eq!(
                eligible["identity"]["package_file_id"], file_id,
                "{id} {target}"
            );
            assert_eq!(eligible["release"]["asset"]["name"], expected["file_name"]);
            assert_eq!(
                eligible["release"]["asset"]["sha256"],
                expected["file_sha256"]
            );
        }

        every_asset_order(&mut links, 0, &mut |links| {
            let mut candidate = facts.clone();
            candidate["releases"][0]["assets"]["links"] = Value::Array(links.to_vec());
            assert_eq!(
                stable(&crate::gitlab::project_observed_releases(port, &candidate).unwrap()),
                selected
            );
        });

        // Controlled sibling reuses a real registry link on this project.
        // The shared Windows hint alone matches both release-link labels.
        let mut sibling = facts.clone();
        let flatpak_link = sibling["releases"][0]["assets"]["links"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|link| link["name"].as_str().unwrap().contains("Flatpak"))
            .unwrap();
        flatpak_link["name"] = "Windows-RelWithDebInfo-Dedicated-Server".into();
        assert_eq!(
            stable(&crate::gitlab::project_observed_releases(port, &sibling).unwrap()),
            selected
        );

        // A neutral link must also fail if its exact registry file is a server.
        let mut mislabeled = facts.clone();
        let file = mislabeled["package_files"]
            .as_object_mut()
            .unwrap()
            .values_mut()
            .flat_map(|files| files.as_array_mut().unwrap())
            .find(|file| file["id"] == recorded_ids[0])
            .unwrap();
        file["file_name"] = "Windows-RelWithDebInfo-Dedicated-Server.zip".into();
        let changed = stable(&crate::gitlab::project_observed_releases(port, &mislabeled).unwrap());
        assert!(changed["windows-x86-64"]["latest_eligible"].is_null());
        assert!(
            changed["windows-x86-64"]["hold_reasons"][0]
                .as_str()
                .unwrap()
                .contains("dedicated server")
        );
        for target in ["linux-x86-64", "macos-x86-64", "macos-aarch64"] {
            assert_eq!(changed[target], selected[target]);
        }
    }
}
