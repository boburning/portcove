//! Production-provider fixtures for uploader continuity. Accounts, times and
//! releases are first-party fixtures, not upstream observations.
use super::*;

const OWNER: u64 = 1;
const REGULAR: u64 = 2;
const FOREIGN: u64 = 9;
const BEFORE: &str = "2026-11-01T12:00:00Z";
const AFTER: &str = "2026-12-01T12:00:00Z";

fn account(id: u64) -> serde_json::Value {
    serde_json::json!({"id": id, "login": format!("account-{id}"), "type": "User"})
}

fn actions_bot() -> serde_json::Value {
    serde_json::json!({"id": 41_898_282, "login": "github-actions[bot]", "type": "Bot"})
}

/// One release whose only package the Windows selector accepts. `uploader` is
/// the provider field verbatim; `None` omits the field entirely.
fn release(
    id: u64,
    tag: &str,
    uploader: Option<serde_json::Value>,
    created_at: &str,
) -> serde_json::Value {
    let mut asset = serde_json::json!({
        "id": id * 10, "name": "game-windows.zip", "size": 42,
        "digest": format!("sha256:{}", "a".repeat(64)),
        "browser_download_url": format!(
            "https://github.com/HarbourMasters/Shipwright/releases/download/{tag}/game-windows.zip"
        ),
        "created_at": created_at,
    });
    if let Some(uploader) = uploader {
        asset["uploader"] = uploader;
    }
    serde_json::json!({
        "id": id, "tag_name": tag, "draft": false, "prerelease": false,
        "published_at": created_at, "assets": [asset]
    })
}

fn repository() -> String {
    ok_json(
        &serde_json::json!({"id": 100, "archived": false, "owner": account(OWNER)}).to_string(),
        "",
    )
}

fn listing(newest_first: &[serde_json::Value]) -> String {
    ok_json(&serde_json::to_string(newest_first).unwrap(), "")
}

fn shipwright() -> PortDefinition {
    crate::Catalog::embedded()
        .unwrap()
        .port("shipwright")
        .unwrap()
        .clone()
}

/// Resolves once through a fresh production provider, as a fresh Install,
/// Update or update check would after the five-minute cache.
async fn resolve(
    port: &PortDefinition,
    newest_first: &[serde_json::Value],
) -> Result<crate::ScopedResolvedRelease> {
    let (origin, _, server) = serve_http(vec![repository(), listing(newest_first)]);
    let provider = GithubReleaseProvider::with_api_root(origin).unwrap();
    let result = provider
        .resolve_scoped(port, ReleaseChannel::Stable, Platform::WindowsX86_64, None)
        .await;
    server.join().unwrap();
    result
}

fn assert_held(error: &PortcoveError, uploader: Option<u64>) {
    assert_eq!(error.code, crate::ErrorCode::Unsupported, "{error:?}");
    assert_eq!(error.details["reason"], "provider_uploader_not_continuous");
    assert_eq!(
        error.details.get("uploader_id").map(String::as_str),
        uploader.map(|id| id.to_string()).as_deref()
    );
}

#[tokio::test]
async fn github_progression_requires_a_continuous_uploader() {
    let port = shipwright();
    let n = release(1, "v1.0.0", Some(account(REGULAR)), BEFORE);

    // N, and N+1 from the same established uploader, follow automatically.
    let resolved = resolve(&port, std::slice::from_ref(&n)).await.unwrap();
    assert_eq!(resolved.release.version, "v1.0.0");
    let same = release(2, "v1.1.0", Some(account(REGULAR)), AFTER);
    let resolved = resolve(&port, &[same, n.clone()]).await.unwrap();
    assert_eq!(resolved.release.version, "v1.1.0");

    // A foreign uploader's N+1 is held with the player reason, and a later
    // N+2 cannot launder that account through its own post-baseline upload.
    let foreign = release(2, "v1.1.0", Some(account(FOREIGN)), AFTER);
    let error = resolve(&port, &[foreign.clone(), n.clone()])
        .await
        .unwrap_err();
    assert_held(&error, Some(FOREIGN));
    assert!(
        error
            .message
            .starts_with("Portcove is holding back this version")
    );
    assert!(error.message.contains("Nothing was downloaded or changed"));
    assert_eq!(error.details["release_tag"], "v1.1.0");
    let laundered = release(3, "v1.2.0", Some(account(FOREIGN)), AFTER);
    let error = resolve(&port, &[laundered, foreign.clone(), n.clone()])
        .await
        .unwrap_err();
    assert_held(&error, Some(FOREIGN));

    // The repository owner and the project's own Actions automation continue.
    for uploader in [account(OWNER), actions_bot()] {
        let next = release(2, "v1.1.0", Some(uploader), AFTER);
        let resolved = resolve(&port, &[next, n.clone()]).await.unwrap();
        assert_eq!(resolved.release.version, "v1.1.0");
    }

    // A response without any uploader facts is UNKNOWN and keeps today's
    // behavior; a selected asset missing the field beside attributed assets is an
    // inconsistent observation and is held. GitHub reporting no account after the
    // baseline is a known refusal.
    let unknown = release(2, "v1.1.0", None, AFTER);
    let unobserved_n = release(1, "v1.0.0", None, BEFORE);
    let resolved = resolve(&port, &[unknown.clone(), unobserved_n])
        .await
        .unwrap();
    assert_eq!(resolved.release.version, "v1.1.0");
    let error = resolve(&port, &[unknown, n.clone()]).await.unwrap_err();
    assert_eq!(error.code, crate::ErrorCode::Unsupported);
    assert_eq!(error.details["reason"], "provider_uploader_not_observed");
    let unattributed = release(2, "v1.1.0", Some(serde_json::Value::Null), AFTER);
    let error = resolve(&port, &[unattributed, n.clone()])
        .await
        .unwrap_err();
    assert_held(&error, None);
    assert!(error.message.contains("doesn't show who uploaded it"));

    // Existing releases keep their behavior whoever uploaded them.
    let existing = release(2, "v1.1.0", Some(account(FOREIGN)), BEFORE);
    let resolved = resolve(&port, &[existing, n.clone()]).await.unwrap();
    assert_eq!(resolved.release.version, "v1.1.0");

    // A maintainer-reviewed uploader continues once accepted by numeric ID, and
    // the acceptance is part of the selection cache identity.
    let mut accepted = port.clone();
    accepted.release.accepted_uploaders = vec![crate::AcceptedUploader {
        id: FOREIGN,
        login: format!("account-{FOREIGN}"),
    }];
    assert_ne!(
        ReleaseSelectionCacheKey::new(&port, ReleaseChannel::Stable, Platform::WindowsX86_64),
        ReleaseSelectionCacheKey::new(&accepted, ReleaseChannel::Stable, Platform::WindowsX86_64)
    );
    let resolved = resolve(&accepted, &[foreign, n]).await.unwrap();
    assert_eq!(resolved.release.version, "v1.1.0");
}

#[tokio::test]
async fn a_held_github_release_is_not_cached_and_requests_no_checksum() {
    let port = shipwright();
    let n = release(1, "v1.0.0", Some(account(REGULAR)), BEFORE);
    // Without a publisher digest, selection would fetch this sidecar next; the
    // refusal must come first, so the fixture serves only metadata requests.
    let mut foreign = release(2, "v1.1.0", Some(account(FOREIGN)), AFTER);
    foreign["assets"][0]["digest"] = serde_json::Value::Null;
    foreign["assets"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!({
            "id": 21, "name": "game-windows.zip.sha256", "size": 80, "digest": null,
            "browser_download_url": "https://downloads.example.invalid/game-windows.zip.sha256",
            "created_at": AFTER, "uploader": account(FOREIGN),
        }));
    let same = release(2, "v1.1.0", Some(account(REGULAR)), AFTER);
    let (origin, _, server) = serve_http(vec![
        repository(),
        listing(&[foreign, n.clone()]),
        repository(),
        listing(&[same, n]),
    ]);
    let provider = GithubReleaseProvider::with_api_root(origin).unwrap();
    let error = provider
        .resolve_scoped(&port, ReleaseChannel::Stable, Platform::WindowsX86_64, None)
        .await
        .unwrap_err();
    assert_held(&error, Some(FOREIGN));
    // The same provider observes upstream again instead of reusing a held result.
    let resolved = provider
        .resolve_scoped(&port, ReleaseChannel::Stable, Platform::WindowsX86_64, None)
        .await
        .unwrap();
    assert_eq!(resolved.release.version, "v1.1.0");
    server.join().unwrap();
}

#[tokio::test]
async fn a_held_update_check_leaves_the_installed_copy_active() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    // Starship declares an executable for every platform this suite runs on.
    let installed =
        crate::retained_build::tests::install(&library, "installed", b"accepted runtime", true);
    let name = match Platform::current().unwrap() {
        Platform::WindowsX86_64 => "starship-windows.zip",
        Platform::LinuxX86_64 => "starship-linux.zip",
        Platform::MacosX86_64 | Platform::MacosAarch64 => "starship-macos.zip",
    };
    let n = release(1, "v1", Some(account(REGULAR)), BEFORE);
    let mut foreign = release(2, "v2", Some(account(FOREIGN)), AFTER);
    foreign["assets"][0]["name"] = serde_json::json!(name);
    let (origin, _, server) = serve_http(vec![repository(), listing(&[foreign, n])]);
    let provider = GithubReleaseProvider::with_api_root(origin).unwrap();
    let service = crate::PortcoveService::with_provider(library, Arc::new(provider)).unwrap();
    let error = service.check_update("starship").await.unwrap_err();
    server.join().unwrap();
    assert_held(&error, Some(FOREIGN));
    let status = service.status("starship").unwrap();
    assert_eq!(status.active.unwrap().id, installed.id);
    assert!(status.staged.is_none());
}
