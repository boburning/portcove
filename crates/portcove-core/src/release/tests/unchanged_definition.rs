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
async fn unchanged_native_definitions_follow_versioned_packages_after_cache_expiry_and_on_fresh_install()
 {
    let catalog = crate::Catalog::embedded().unwrap();
    for (id, old_tag, old_name, new_tag, new_name) in [
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
    ] {
        let port = catalog.port(id).unwrap();
        let old = release(old_tag, vec![asset(old_name, Some('a'))]);
        let new = release(
            new_tag,
            vec![
                asset(new_name, Some('b')),
                asset(
                    &new_name
                        .replace("windows", "linux")
                        .replace("Windows", "Linux"),
                    Some('c'),
                ),
                asset(
                    &new_name
                        .replace("x64", "arm64")
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
async fn successor_resolution_refuses_lost_variant_ambiguity_wrong_architecture_and_missing_integrity()
 {
    let port = variant_port();
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
            "{name}; never silently fall back to N"
        );
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
