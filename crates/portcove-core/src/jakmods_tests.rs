use super::*;
use crate::{Catalog, retained_build::tests::fixture, test_http::serve_routed_http_bytes};
use serde_json::json;

fn feed(include_new: bool) -> Value {
    let mut result = json!({
        "schemaVersion":"1.0.0","sourceName":"JakMods",
        "mods": {
            "external": {"displayName":"External","supportedGames":["jak1"],"versions":[],
                "externalLink":"https://teamruns.web.app/"},
            "other-game": {"displayName":"Other game","supportedGames":["jak2"],"versions":[]},
            "unknown-build": {"displayName":"Build unknown","supportedGames":["jak1"],
                "versions":[{"version":"1","supportedGames":["jak1"],"assets":{
                    "windows":"https://outside.example/windows-v1.0.0.zip"}}]},
        }
    });
    if include_new {
        result["mods"]["new-project"] = json!({
            "displayName":"New Project","supportedGames":["jak1","jak3"],
            "description":"description",
            "websiteUrl":"https://github.com/example/project",
            "coverArtUrl":"https://unsafe.example/cover.png",
            "thumbnailArtUrl":"https://raw.githubusercontent.com/example/project/main/cover.png",
            "perGameConfig":{"jak1":{"displayName":"New Project for Jak 1"}},
            "versions":[{
                "version":"2","publishedDate":"2026-11-17T00:00:00Z","supportedGames":["jak3"],
                "assets":{"windows":"https://github.com/example/project/releases/download/v2/windows-v2.0.0.zip"}
            },{
                "version":"1","publishedDate":"2026-11-10T00:00:00Z","supportedGames":["jak1","jak3"],
                "assets":{
                    "windows":"https://github.com/example/project/releases/download/v1/windows-v1.0.0.zip",
                    "linux":"https://github.com/example/project/releases/download/v1/linux-v1.0.0.tar.gz",
                    "macos":"https://github.com/example/project/releases/download/v1/macos-intel-v1.0.0.tar.gz"
                },
                "assetDownloadCounts":{"windows":0,"macos":7}
            }]
        });
    }
    result
}

#[test]
fn scope_uses_reviewed_setup_instead_of_a_port_id_allowlist() {
    let catalog = Catalog::embedded().unwrap();
    for (id, game) in [
        ("opengoal-jak1", "jak1"),
        ("opengoal-jak2", "jak2"),
        ("opengoal-jak3", "jak3"),
    ] {
        let mut port = catalog.port(id).unwrap().clone();
        assert_eq!(jakmods_game(&port), Some(game));
        port.id = format!("another-reviewed-{game}");
        assert_eq!(jakmods_game(&port), Some(game));
        port.setup_arguments[1] = "uncategorized-game".into();
        assert_eq!(jakmods_game(&port), None);
    }
    assert_eq!(jakmods_game(catalog.port("shipwright").unwrap()), None);
}

#[test]
fn release_game_platform_count_and_source_coverage_stay_separate() {
    let (before, _) = project_feed(&feed(false), "jak1", Platform::WindowsX86_64).unwrap();
    let (after, complete) = project_feed(&feed(true), "jak1", Platform::WindowsX86_64).unwrap();
    assert_eq!(after.len(), before.len() + 1);
    assert!(!complete, "the malformed build keeps coverage partial");
    let current = &after[0];
    assert_eq!(current.id, "new-project");
    assert_eq!(current.name, "New Project for Jak 1");
    assert!(
        current
            .artwork_url
            .as_deref()
            .unwrap()
            .contains("raw.githubusercontent.com")
    );
    assert_eq!(current.releases.len(), 1, "Jak 3-only release excluded");
    let builds = &current.releases[0].builds;
    assert_eq!(builds[0].downloads, Some(0));
    assert_eq!(builds[1].downloads, None);
    assert_eq!(builds[2].platform, Platform::MacosX86_64);
    assert_eq!(builds[2].downloads, Some(7));
    assert_eq!(after[1].kind, JakModsProjectKind::External);
    assert_eq!(after[2].build_status, JakModsBuildStatus::Unknown);
    let (arm, _) = project_feed(&feed(true), "jak1", Platform::MacosAarch64).unwrap();
    let intel_only = arm.iter().find(|row| row.id == "new-project").unwrap();
    assert_eq!(intel_only.build_status, JakModsBuildStatus::Unavailable);
    let (jak3, _) = project_feed(&feed(true), "jak3", Platform::WindowsX86_64).unwrap();
    assert_eq!(jak3[0].releases[0].version, "2");
}

#[test]
fn wrong_architecture_assets_leave_the_affected_builds_unknown() {
    let mut snapshot = feed(true);
    let builds = &mut snapshot["mods"]["new-project"]["versions"][1]["assets"];
    builds["windows"] =
        json!("https://github.com/example/project/releases/download/v1/windows-v1.0.0-ARM64.zip");
    builds["linux"] = json!(
        "https://github.com/example/project/releases/download/v1/linux-aarch64-v1.0.0.tar.gz"
    );
    for platform in [Platform::WindowsX86_64, Platform::LinuxX86_64] {
        let (projects, complete) = project_feed(&snapshot, "jak1", platform).unwrap();
        let project = projects.iter().find(|row| row.id == "new-project").unwrap();
        assert!(!complete);
        assert_eq!(project.build_status, JakModsBuildStatus::Unknown);
        assert_eq!(project.releases[0].builds.len(), 1);
        assert_eq!(
            project.releases[0].builds[0].platform,
            Platform::MacosX86_64
        );
    }
    for filename in [
        "windows-v1.2.3-win32.zip",
        "windows-v1.2.3-i686.zip",
        "windows-1.2.3.zip",
    ] {
        let url = Url::parse(&format!(
            "https://github.com/example/project/releases/download/v1/{filename}"
        ))
        .unwrap();
        assert_eq!(build_platform("windows", &url), None, "{filename}");
    }
    let variant = Url::parse(
        "https://github.com/example/project/releases/download/v1/linux-v1.2.3-jak3.1.tar.gz",
    )
    .unwrap();
    assert_eq!(
        build_platform("linux", &variant),
        Some(Platform::LinuxX86_64)
    );
}

#[tokio::test]
async fn catalog_revalidates_then_shares_backoff_across_services_and_games() {
    let (_temp, service, _) = fixture();
    let body = feed(true).to_string();
    let ok = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nETag: \"fixture\"\r\nConnection: close\r\n\r\n{body}", body.len()).into_bytes();
    let mut responses = [
        ok.clone(),
        b"HTTP/1.1 304 Not Modified\r\nConnection: close\r\n\r\n".to_vec(),
        b"HTTP/1.1 429 Too Many Requests\r\nRetry-After: 60\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
    ].into_iter();
    let (root, requests, server) =
        serve_routed_http_bytes(5, move |_| responses.next().unwrap_or_else(|| ok.clone()));
    let library = service.library().clone();
    library
        .jakmods
        .fixture_feed
        .set(Url::parse(&root).unwrap())
        .unwrap();
    let platform = Platform::WindowsX86_64;
    let fresh = service
        .jakmods_catalog("opengoal-jak1", platform)
        .await
        .unwrap();
    let revalidated = service
        .jakmods_catalog("opengoal-jak1", platform)
        .await
        .unwrap();
    let throttled = service
        .jakmods_catalog("opengoal-jak1", platform)
        .await
        .unwrap();
    let another = PortcoveService::new_read_only(library).unwrap();
    let other_game = another
        .jakmods_catalog("opengoal-jak2", platform)
        .await
        .unwrap();
    let repeated = another
        .jakmods_catalog("opengoal-jak1", platform)
        .await
        .unwrap();
    assert_eq!(fresh.freshness, ProviderFreshness::Fresh);
    assert_eq!(revalidated.freshness, ProviderFreshness::Revalidated);
    assert_eq!(throttled.freshness, ProviderFreshness::Stale);
    assert_eq!(other_game.freshness, ProviderFreshness::Stale);
    assert_eq!(other_game.projects[0].id, "other-game");
    assert_eq!(repeated.projects, fresh.projects);
    assert_eq!(repeated.freshness, ProviderFreshness::Stale);
    server.join().unwrap();
    let requests = requests.try_iter().collect::<Vec<_>>();
    assert_eq!(
        requests.len(),
        3,
        "backoff must prevent new network requests"
    );
    assert!(!requests[0].to_ascii_lowercase().contains("if-none-match"));
    assert!(
        requests[1]
            .to_ascii_lowercase()
            .contains("if-none-match: \"fixture\"")
    );
}

#[test]
#[ignore = "requires the two retained upstream JakMods feed snapshots for the explicit replay in docs/CLI.md"]
fn real_before_and_served_feed_addition_appears_only_for_jak1() {
    let root = std::path::PathBuf::from(
        std::env::var_os("PORTCOVE_JAKMODS_REPLAY").expect("snapshot directory"),
    );
    let read = |name| -> Value {
        serde_json::from_slice(&std::fs::read(root.join(name)).unwrap()).unwrap()
    };
    let before = read("8faab02231d48ab3246bbe9e57cd71741dfbe3ed.json");
    let served = read("8cd96e1a3557f5066de62e911d3eb8a59727834a.json");
    let projects = |value, game, platform| project_feed(value, game, platform).unwrap().0;
    for platform in [
        Platform::WindowsX86_64,
        Platform::LinuxX86_64,
        Platform::MacosX86_64,
    ] {
        assert!(
            projects(&before, "jak1", platform)
                .iter()
                .all(|row| row.id != "bullet-hell")
        );
        let rows = projects(&served, "jak1", platform);
        let item = rows.iter().find(|row| row.id == "bullet-hell").unwrap();
        assert_eq!(item.build_status, JakModsBuildStatus::Available);
        for game in ["jak2", "jak3"] {
            assert!(
                projects(&served, game, platform)
                    .iter()
                    .all(|row| row.id != "bullet-hell")
            );
        }
    }
    let arm = projects(&served, "jak1", Platform::MacosAarch64);
    assert_eq!(
        arm.iter()
            .find(|row| row.id == "bullet-hell")
            .unwrap()
            .build_status,
        JakModsBuildStatus::Unavailable
    );
}
