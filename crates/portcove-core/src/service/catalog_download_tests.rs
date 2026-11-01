use super::*;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::{Read, Write},
    net::TcpListener,
    sync::{
        Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    thread,
    time::Duration,
};

fn fixture() -> (tempfile::TempDir, PortcoveService, CatalogDownloadRequest) {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let mut service = PortcoveService::new(library).unwrap();
    let listing: PortListing = serde_json::from_value(json!({
        "id":"directory-download-fixture", "name":"Directory download fixture",
        "summary":"An unintegrated upstream project", "project_url":"https://github.com/owner/game",
        "release_url":"https://github.com/owner/game/releases", "platforms":[]
    }))
    .unwrap();
    service.catalog = Catalog::from_json(r#"{"schema_version":1,"source_profiles":[],"ports":[]}"#)
        .unwrap()
        .with_listing_document(crate::CatalogListingDocument {
            format_version: 1,
            listings: vec![listing],
        })
        .unwrap();
    let parent = temporary.path().join("user-games");
    fs::create_dir(&parent).unwrap();
    let request = CatalogDownloadRequest {
        port_id: "directory-download-fixture".into(),
        release_id: 7,
        asset_id: 11,
        destination_parent: fs::canonicalize(parent).unwrap(),
        extract_archive: true,
    };
    (temporary, service, request)
}

fn archive() -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    writer
        .start_file("readme.txt", zip::write::SimpleFileOptions::default())
        .unwrap();
    writer
        .write_all(b"Follow the upstream setup instructions.")
        .unwrap();
    writer.finish().unwrap().into_inner()
}

#[tokio::test]
async fn catalog_default_candidates_use_recommendation_and_explicit_choices_win() {
    let (_temporary, mut service, request) = fixture();
    assert_eq!(
        service.catalog_download_channel(&request.port_id).unwrap(),
        ReleaseChannel::Stable
    );
    let mut document = service.catalog.listing_document().clone();
    document.listings[0].recommended_download_channel = Some(ReleaseChannel::Beta);
    service.catalog = service
        .catalog
        .clone()
        .with_listing_document(document)
        .unwrap();
    assert_eq!(
        service.catalog_download_channel(&request.port_id).unwrap(),
        ReleaseChannel::Beta
    );
    assert!(service.catalog_download_channel("missing-port").is_err());
    let github = GithubFixture::new(archive(), None, None);
    github.releases.lock().unwrap().insert(0, json!({"id":9,"tag_name":"v2-preview","draft":false,"prerelease":true,"published_at":null,"assets":[]}));
    let mut preview_asset = github.assets.lock().unwrap()[0].clone();
    preview_asset["id"] = json!(22);
    github
        .release_assets
        .lock()
        .unwrap()
        .insert(9, vec![preview_asset]);
    let recommended = service
        .catalog_download_options_with_provider(
            &request.port_id,
            None,
            None,
            Some(&github.provider),
        )
        .await
        .unwrap();
    assert_eq!(recommended.selected_release_id, Some(9));
    assert_eq!(recommended.candidates[0].asset_id, 22);
    let explicit = service
        .catalog_download_options_with_provider(
            &request.port_id,
            None,
            Some(ReleaseChannel::Stable),
            Some(&github.provider),
        )
        .await
        .unwrap();
    assert_eq!(explicit.selected_release_id, Some(7));
    let historical = service
        .catalog_download_options_with_provider(
            &request.port_id,
            Some(7),
            None,
            Some(&github.provider),
        )
        .await
        .unwrap();
    assert_eq!(historical.selected_release_id, Some(7));
    assert!(service.pending_setups().unwrap().is_empty());
}

fn restrict_download(service: &mut PortcoveService, reason: &str) {
    let mut document = service.catalog.listing_document().clone();
    document.format_version = 2;
    document.listings[0].download_block_reason = Some(reason.into());
    service.catalog = service
        .catalog
        .clone()
        .with_listing_document(document)
        .unwrap();
}

#[cfg(windows)]
#[tokio::test]
async fn downloaded_win32_game_is_distinguished_from_converter_without_running_either() {
    let (_temporary, mut service, request) = fixture();
    let mut listings = service.catalog.listing_document().clone();
    listings.listings[0].name = "Classic Game / Reimplementation".into();
    listings.listings[0].original_game_title = Some("Classic Game".into());
    service.catalog = service
        .catalog
        .clone()
        .with_listing_document(listings)
        .unwrap();
    let github = GithubFixture::new(archive(), None, None);
    let preview = service
        .catalog_download_preview_with_provider(&request, &github.provider)
        .await
        .unwrap();
    let pending = service
        .download_catalog_package_with_provider(
            &request,
            &preview.preview_sha256,
            |_| {},
            &github.provider,
        )
        .await
        .unwrap();
    let mut pe = vec![0_u8; 88];
    pe[..2].copy_from_slice(b"MZ");
    pe[60..64].copy_from_slice(&64_u32.to_le_bytes());
    pe[64..68].copy_from_slice(b"PE\0\0");
    pe[68..70].copy_from_slice(&0x014c_u16.to_le_bytes());
    pe[86..88].copy_from_slice(&2_u16.to_le_bytes());
    for name in ["ClassicGame.exe", "DataConverter.exe"] {
        fs::write(pending.path.join(name), &pe).unwrap();
    }
    let targets = service
        .discover_setup_launch_targets(&request.port_id, &pending.id)
        .unwrap();
    assert!(targets.complete);
    assert_eq!(targets.candidates.len(), 2);
    assert_eq!(
        targets.recommended_executable,
        Some(pending.path.join("ClassicGame.exe"))
    );
    assert!(service.library.all_installs().unwrap().is_empty());
    assert!(
        service
            .library
            .status(&request.port_id, ReleaseChannel::Stable)
            .unwrap()
            .external_runtime
            .is_none()
    );
    fs::write(pending.path.join("ClassicGameAlternate.exe"), &pe).unwrap();
    let ambiguous = service
        .discover_setup_launch_targets(&request.port_id, &pending.id)
        .unwrap();
    assert!(ambiguous.complete);
    assert!(ambiguous.recommended_executable.is_none());
}

#[tokio::test]
async fn downloaded_project_named_player_is_suggested_without_overriding_safety_or_progress() {
    let (temporary, mut service, request) = fixture();
    let mut listings = service.catalog.listing_document().clone();
    listings.listings[0].name = "Classic Title / Community Reimplementation".into();
    listings.listings[0].original_game_title = Some("Classic Title".into());
    service.catalog = service
        .catalog
        .clone()
        .with_listing_document(listings)
        .unwrap();
    let github = GithubFixture::new(archive(), None, None);
    let preview = service
        .catalog_download_preview_with_provider(&request, &github.provider)
        .await
        .unwrap();
    let pending = service
        .download_catalog_package_with_provider(
            &request,
            &preview.preview_sha256,
            |_| {},
            &github.provider,
        )
        .await
        .unwrap();
    let probe_root = temporary.path().join("native-fixture");
    fs::create_dir(&probe_root).unwrap();
    let probe = crate::test_fixture::build_probe(&probe_root);
    let filename = if cfg!(windows) { "Game.exe" } else { "Game" };
    let player_root = pending.path.join("player/bin");
    fs::create_dir_all(&player_root).unwrap();
    let player = player_root.join(filename);
    fs::copy(&probe, &player).unwrap();
    let helper = player_root.join(if cfg!(windows) {
        "Game-updater.exe"
    } else {
        "Game-updater"
    });
    fs::copy(&probe, &helper).unwrap();
    let before = serde_json::to_value(service.pending_setups().unwrap()).unwrap();
    let targets = service
        .discover_setup_launch_targets(&request.port_id, &pending.id)
        .unwrap();
    assert!(targets.complete);
    assert_eq!(targets.recommended_executable, Some(player.clone()));
    assert_eq!(targets.candidates.len(), 2);
    assert!(targets.candidates.iter().any(|candidate| {
        candidate.executable == player && candidate.working_directory == player_root
    }));
    assert!(
        targets
            .candidates
            .iter()
            .any(|candidate| { candidate.executable == helper && candidate.supporting_program })
    );
    let recommend = || {
        service
            .discover_setup_launch_targets(&request.port_id, &pending.id)
            .unwrap()
            .recommended_executable
    };

    let other_root = pending.path.join("alternate");
    fs::create_dir(&other_root).unwrap();
    let duplicate = other_root.join(filename);
    fs::copy(&probe, &duplicate).unwrap();
    assert!(recommend().is_none());
    fs::remove_file(duplicate).unwrap();
    let raw_package = pending.path.join(&pending.artifact.name);
    fs::write(&raw_package, b"retained raw package").unwrap();
    assert!(recommend().is_none());
    fs::remove_file(raw_package).unwrap();
    fs::remove_file(&player).unwrap();
    let prefix_only = player_root.join(if cfg!(windows) {
        "GameEditor.exe"
    } else {
        "GameEditor"
    });
    fs::copy(&probe, &prefix_only).unwrap();
    assert!(recommend().is_none());
    assert_eq!(
        serde_json::to_value(service.pending_setups().unwrap()).unwrap(),
        before
    );
    assert!(service.library.all_installs().unwrap().is_empty());
    assert!(
        service
            .library
            .status(&request.port_id, ReleaseChannel::Stable)
            .unwrap()
            .external_runtime
            .is_none()
    );

    fs::copy(&probe, &player).unwrap();
    let reviewed_player = player_root.join(if cfg!(windows) {
        "ReviewedPlayer.exe"
    } else {
        "ReviewedPlayer"
    });
    fs::copy(&probe, &reviewed_player).unwrap();
    let embedded = Catalog::embedded().unwrap();
    let mut document = embedded.document().clone();
    let mut managed = embedded
        .ports()
        .iter()
        .find(|port| port.adapter == AdapterKind::NativePortable)
        .unwrap()
        .clone();
    let platform = Platform::current().unwrap();
    managed.id = request.port_id.clone();
    managed.platforms = vec![platform];
    managed.executable_hints = std::collections::BTreeMap::from([(
        platform,
        vec![
            reviewed_player
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into(),
        ],
    )]);
    managed.release.asset_hints =
        std::collections::BTreeMap::from([(platform, vec!["runtime.zip".into()])]);
    document.ports.push(managed);
    service.catalog = Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap();
    assert_eq!(
        service
            .discover_setup_launch_targets(&request.port_id, &pending.id)
            .unwrap()
            .recommended_executable,
        Some(reviewed_player)
    );
}

#[test]
fn retained_restricted_registration_survives_removal_from_the_current_directory() {
    let (_temporary, mut service, request) = fixture();
    restrict_download(
        &mut service,
        "Fresh acquisition needs upstream permission review.",
    );
    let working = request.destination_parent.join("existing-permitted-copy");
    fs::create_dir(&working).unwrap();
    let executable = crate::test_fixture::build_probe(&working);
    let preview = service
        .preview_user_selected_runtime(&request.port_id, &executable, &working, &[])
        .unwrap();
    let authorization = service
        .authorize_user_selected_runtime(
            &request.port_id,
            &executable,
            &working,
            &[],
            &preview.preview_sha256,
        )
        .unwrap();
    let registered = service
        .register_user_selected_runtime(
            &request.port_id,
            &executable,
            &working,
            &[],
            &authorization.token,
        )
        .unwrap();
    service.catalog = Catalog::from_json(r#"{"schema_version":1,"ports":[]}"#).unwrap();
    let projected = service
        .catalog_with_registered_listings(
            service.catalog.clone(),
            &service.library.connection().unwrap(),
        )
        .unwrap();
    assert_eq!(projected.listing_document().format_version, 2);
    assert!(
        projected
            .listing(&request.port_id)
            .unwrap()
            .download_block_reason
            .is_some()
    );
    assert_eq!(
        service.listing_statuses().unwrap()[0]
            .status
            .external_runtime
            .as_ref()
            .unwrap()
            .id,
        registered.id
    );
    let retained_url = projected
        .listing(&request.port_id)
        .unwrap()
        .project_url
        .clone();
    assert!(service.is_reviewed_resource_url(&retained_url).unwrap());
    let mut current_listing = projected.listing(&request.port_id).unwrap().clone();
    current_listing.project_url = "https://github.com/owner/current-project".into();
    service.catalog = Catalog::from_json(r#"{"schema_version":1,"ports":[]}"#)
        .unwrap()
        .with_listing_document(crate::CatalogListingDocument {
            format_version: 2,
            listings: vec![current_listing],
        })
        .unwrap();
    assert!(!service.is_reviewed_resource_url(&retained_url).unwrap());
    assert!(
        service
            .is_reviewed_resource_url("https://github.com/owner/current-project")
            .unwrap()
    );
    service.catalog = Catalog::from_json(r#"{"schema_version":1,"ports":[]}"#).unwrap();
    let removal = service.preview_external_removal(&request.port_id).unwrap();
    let authorization = service
        .authorize_external_removal(&request.port_id, &removal.preview_sha256)
        .unwrap();
    service
        .remove_external_runtime(&request.port_id, &authorization.token)
        .unwrap();
    assert!(!service.is_reviewed_resource_url(&retained_url).unwrap());
    assert!(executable.exists());
}

#[test]
fn retained_restricted_pending_setup_survives_a_legacy_current_directory() {
    let (_temporary, mut service, request) = fixture();
    restrict_download(
        &mut service,
        "Fresh acquisition needs upstream permission review.",
    );
    // A retained row can outlive the current catalog that described it. This
    // constructs that accepted row, rather than bypassing the acquisition API.
    let (pending, _stage, _) = intent(&service, &request);
    service.catalog = Catalog::from_json(r#"{"schema_version":1,"ports":[]}"#).unwrap();
    let projected = service
        .catalog_with_registered_listings(
            service.catalog.clone(),
            &service.library.connection().unwrap(),
        )
        .unwrap();
    assert_eq!(projected.listing_document().format_version, 2);
    assert_eq!(
        projected
            .listing(&request.port_id)
            .unwrap()
            .download_block_reason,
        pending.listing.download_block_reason
    );
    assert_eq!(service.listing_statuses().unwrap().len(), 1);
    assert!(
        service
            .is_reviewed_resource_url(&pending.listing.project_url)
            .unwrap()
    );
    let mut current_listing = pending.listing.clone();
    current_listing.project_url = "https://github.com/owner/current-project".into();
    service.catalog = Catalog::from_json(r#"{"schema_version":1,"ports":[]}"#)
        .unwrap()
        .with_listing_document(crate::CatalogListingDocument {
            format_version: 2,
            listings: vec![current_listing],
        })
        .unwrap();
    assert!(
        !service
            .is_reviewed_resource_url(&pending.listing.project_url)
            .unwrap()
    );
    assert!(
        service
            .is_reviewed_resource_url("https://github.com/owner/current-project")
            .unwrap()
    );
    service.catalog = Catalog::from_json(r#"{"schema_version":1,"ports":[]}"#).unwrap();
    service
        .forget_pending_setup(&pending.port_id, &pending.id)
        .unwrap();
    assert!(
        !service
            .is_reviewed_resource_url(&pending.listing.project_url)
            .unwrap()
    );
}

#[tokio::test]
async fn authored_download_restriction_blocks_options_preview_and_mutation_before_network() {
    let (_temporary, mut service, request) = fixture();
    let upstream = GithubFixture::new(archive(), None, None);
    let reason = "This release needs an attributable upstream component permission.";
    restrict_download(&mut service, reason);
    let options = service
        .catalog_download_candidates(&request.port_id)
        .await
        .unwrap();
    assert!(!options.allowed);
    assert_eq!(options.reason.as_deref(), Some(reason));
    assert!(options.candidates.is_empty());
    assert!(options.coverage.is_none());
    let error = service
        .catalog_download_preview_with_provider(&request, &upstream.provider)
        .await
        .unwrap_err();
    assert_eq!(error.message, reason);
    let error = service
        .download_catalog_package_with_provider(
            &request,
            &"a".repeat(64),
            |_| {},
            &upstream.provider,
        )
        .await
        .unwrap_err();
    assert_eq!(error.message, reason);
    assert_eq!(upstream.requests.load(Ordering::SeqCst), 0);
    assert_eq!(
        fs::read_dir(&request.destination_parent).unwrap().count(),
        0
    );
    assert!(service.pending_setups().unwrap().is_empty());
}

async fn assert_embedded_player_download_holds(ids: &[&str]) {
    assert_embedded_listing_download_holds(ids, true).await;
}

async fn assert_embedded_listing_download_holds(ids: &[&str], expected_manual_setup: bool) {
    for &id in ids {
        let (_temporary, mut service, mut request) = fixture();
        service.catalog = Catalog::embedded().unwrap();
        request.port_id = id.into();
        assert!(service.catalog.port(id).is_err());
        assert_eq!(
            service.catalog.listing(id).unwrap().manual_setup.is_some(),
            expected_manual_setup
        );
        let reason = service
            .catalog
            .listing(id)
            .unwrap()
            .download_block_reason
            .clone()
            .unwrap();
        let upstream = GithubFixture::new(archive(), None, None);
        let options = service
            .catalog_download_options_with_provider(id, None, None, Some(&upstream.provider))
            .await
            .unwrap();
        assert!(!options.allowed);
        assert_eq!(options.reason.as_deref(), Some(reason.as_str()));
        assert!(options.candidates.is_empty());
        assert!(options.coverage.is_none());
        let error = service
            .catalog_download_preview_with_provider(&request, &upstream.provider)
            .await
            .unwrap_err();
        assert_eq!(error.message, reason);
        let error = service
            .download_catalog_package_with_provider(
                &request,
                &"a".repeat(64),
                |_| {},
                &upstream.provider,
            )
            .await
            .unwrap_err();
        assert_eq!(error.message, reason);
        assert_eq!(upstream.requests.load(Ordering::SeqCst), 0);
        assert_eq!(
            fs::read_dir(&request.destination_parent).unwrap().count(),
            0
        );
        assert!(service.pending_setups().unwrap().is_empty());
    }
}

#[tokio::test]
async fn embedded_cannonball_listing_routes_keep_download_hold_before_network() {
    assert_embedded_player_download_holds(&["cannonball-outrun", "cannonball-dx-outrun"]).await;
}

#[tokio::test]
async fn embedded_psx_permitted_players_keep_download_hold_before_network() {
    assert_embedded_player_download_holds(&[
        "mstan-battle-arena-toshinden-recomp",
        "novapowers0-bloody-roar-ii-recomp",
    ])
    .await;
}

#[tokio::test]
async fn embedded_mmx_source_player_keeps_package_hold_before_network() {
    assert_embedded_player_download_holds(&["mega-man-x-snes-recomp"]).await;
}

#[tokio::test]
async fn embedded_retained_acquisition_holds_refuse_before_network() {
    assert_embedded_listing_download_holds(
        &[
            "pokemon-yellow-recomp",
            "zelda-link-s-awakening-dx-hd",
            "star-wars-shadows-of-the-empire-n64-sote-recomp",
        ],
        false,
    )
    .await;
}

#[tokio::test]
async fn embedded_ps1_selected_package_permission_holds_refuse_before_network() {
    assert_embedded_player_download_holds(&[
        "rage-racer-rage-racer-pc",
        "x-men-mutant-academy-2-xmen-mutant-academy-2-pc",
    ])
    .await;
}

#[tokio::test]
async fn embedded_vandal_component_permission_hold_refuses_before_network() {
    assert_embedded_listing_download_holds(&["vandal-hearts-vandalhearts-pcport"], false).await;
}

#[tokio::test]
async fn embedded_skate3_package_use_hold_refuses_before_network() {
    assert_embedded_listing_download_holds(&["skate-3-recomp"], true).await;
}

#[tokio::test]
async fn embedded_dprecomp_shader_component_hold_refuses_before_network() {
    assert_embedded_listing_download_holds(&["deadly-premonition-dprecomp"], true).await;
}

#[tokio::test]
async fn embedded_kameo_linked_binary_permission_hold_refuses_before_network() {
    assert_embedded_listing_download_holds(&["kameo-repowered"], true).await;
}

#[tokio::test]
async fn embedded_ackman_translation_component_hold_refuses_before_network() {
    assert_embedded_listing_download_holds(&["go-go-ackman-go-go-ackman-recompiled"], true).await;
}

#[tokio::test]
async fn newly_restricted_listing_invalidates_an_earlier_download_review_without_publication() {
    let (_temporary, mut service, request) = fixture();
    let upstream = GithubFixture::new(archive(), None, None);
    let preview = service
        .catalog_download_preview_with_provider(&request, &upstream.provider)
        .await
        .unwrap();
    let before = upstream.requests.load(Ordering::SeqCst);
    restrict_download(
        &mut service,
        "Recheck the changed upstream permission before downloading.",
    );
    assert!(
        service
            .download_catalog_package_with_provider(
                &request,
                &preview.preview_sha256,
                |_| {},
                &upstream.provider
            )
            .await
            .is_err()
    );
    assert_eq!(upstream.requests.load(Ordering::SeqCst), before);
    assert!(!preview.destination_path.exists());
    assert!(service.pending_setups().unwrap().is_empty());
}

struct GithubFixture {
    provider: GithubReleaseProvider,
    assets: Arc<Mutex<Vec<Value>>>,
    releases: Arc<Mutex<Vec<Value>>>,
    release_assets: Arc<Mutex<HashMap<u64, Vec<Value>>>>,
    requests: Arc<AtomicUsize>,
    stopped: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}

impl GithubFixture {
    fn new(bytes: Vec<u8>, digest: Option<String>, sidecar: Option<String>) -> Self {
        Self::for_repository("owner/game", bytes, digest, sidecar)
    }

    fn for_repository(
        repository: &str,
        bytes: Vec<u8>,
        digest: Option<String>,
        sidecar: Option<String>,
    ) -> Self {
        let release_path = format!("/repos/{repository}/releases");
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let mut inventory = vec![json!({ "id":11,"name":"game.zip","size":bytes.len(),
            "browser_download_url":format!("{origin}/download/game.zip"),"digest":digest })];
        if let Some(sidecar) = &sidecar {
            inventory.push(
                json!({"id":12,"name":"game.zip.sha256","size":sidecar.len(),
                "browser_download_url":format!("{origin}/download/game.zip.sha256"),"digest":null}),
            );
        }
        let assets = Arc::new(Mutex::new(inventory));
        let releases = Arc::new(Mutex::new(vec![
            json!({"id":7,"tag_name":"v1.0","draft":false,"prerelease":false,"published_at":null,"assets":[]}),
        ]));
        let release_assets: Arc<Mutex<HashMap<u64, Vec<Value>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let stopped = Arc::new(AtomicBool::new(false));
        let requests = Arc::new(AtomicUsize::new(0));
        let (thread_assets, thread_stopped, thread_requests) =
            (assets.clone(), stopped.clone(), requests.clone());
        let (thread_releases, thread_release_assets) = (releases.clone(), release_assets.clone());
        let worker = thread::spawn(move || {
            while !thread_stopped.load(Ordering::SeqCst) {
                let mut stream = match listener.accept() {
                    Ok((stream, _)) => stream,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(error) => panic!("fixture accept: {error}"),
                };
                // Windows accepted sockets can inherit the polling listener's
                // nonblocking mode. Serve each request with bounded blocking I/O.
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                stream
                    .set_write_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = [0; 8192];
                let size = stream.read(&mut request).unwrap();
                let request = String::from_utf8_lossy(&request[..size]);
                let path = request
                    .lines()
                    .next()
                    .unwrap()
                    .split_whitespace()
                    .nth(1)
                    .unwrap();
                thread_requests.fetch_add(1, Ordering::SeqCst);
                let url = reqwest::Url::parse(&format!("http://fixture.test{path}")).unwrap();
                let query = url.query_pairs().collect::<HashMap<_, _>>();
                let page: usize = query
                    .get("page")
                    .map(|value| value.parse().unwrap())
                    .unwrap_or(1);
                let page_size: usize = query
                    .get("per_page")
                    .map(|value| value.parse().unwrap())
                    .unwrap_or(100);
                let page_bytes = |values: &[Value]| {
                    serde_json::to_vec(
                        &values
                            .iter()
                            .skip((page - 1) * page_size)
                            .take(page_size)
                            .collect::<Vec<_>>(),
                    )
                    .unwrap()
                };
                // Deliberately omit embedded assets: the dedicated, paginated
                // endpoint is the complete checksum authority, including sidecars.
                let body = if path.contains("/assets?") {
                    let release_id: u64 = url.path().split('/').nth(5).unwrap().parse().unwrap();
                    let inventory = thread_release_assets
                        .lock()
                        .unwrap()
                        .get(&release_id)
                        .cloned()
                        .unwrap_or_else(|| thread_assets.lock().unwrap().clone());
                    page_bytes(&inventory)
                } else if path == format!("{release_path}/7") {
                    serde_json::to_vec(&thread_releases.lock().unwrap()[0]).unwrap()
                } else if path.starts_with(&format!("{release_path}?")) {
                    page_bytes(&thread_releases.lock().unwrap())
                } else if path == "/download/game.zip" {
                    bytes.clone()
                } else if path == "/download/game.zip.sha256" {
                    sidecar.clone().unwrap().into_bytes()
                } else {
                    panic!("unexpected fixture request: {path}")
                };
                let header = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                if stream.write_all(header.as_bytes()).is_ok() {
                    let _ = stream.write_all(&body);
                }
            }
        });
        Self {
            provider: GithubReleaseProvider::with_api_root(origin).unwrap(),
            assets,
            releases,
            release_assets,
            requests,
            stopped,
            worker: Some(worker),
        }
    }
}

impl Drop for GithubFixture {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.worker.take().unwrap().join().unwrap();
    }
}

#[tokio::test]
async fn channel_selection_reaches_beyond_recent_history_without_browsing_every_release() {
    for channel in [
        ReleaseChannel::Stable,
        ReleaseChannel::Beta,
        ReleaseChannel::Rolling,
    ] {
        let github = GithubFixture::new(archive(), None, None);
        *github.releases.lock().unwrap() = (1..=120)
            .map(|id| json!({
                "id":id,
                "tag_name":if channel == ReleaseChannel::Rolling && id == 115 { "nightly".into() } else { format!("v{id}") },
                "draft":false,
                "prerelease":if channel == ReleaseChannel::Stable { id < 115 } else { channel == ReleaseChannel::Beta && id == 115 },
                "published_at":null,"assets":[]
            }))
            .collect();
        let (candidates, coverage, summaries, selected) = github
            .provider
            .catalog_download_options("owner/game", None, channel, Some("nightly"))
            .await
            .unwrap();
        assert_eq!(selected, Some(115), "{channel:?}");
        assert_eq!(candidates[0].release_id, 115);
        assert_eq!(summaries.len(), 11, "recent ten plus selected channel");
        assert_eq!(summaries.last().unwrap().id, 115);
        assert!(
            !coverage.release_history_complete,
            "history browsing stays bounded"
        );
        assert_eq!(coverage.release_limit, 10);
        assert_eq!(coverage.releases_checked, 1);
        assert_eq!(github.requests.load(Ordering::SeqCst), 4);
    }
}

#[tokio::test]
async fn preview_falls_back_only_after_bounded_complete_channel_observation() {
    let github = GithubFixture::new(archive(), None, None);
    *github.releases.lock().unwrap() = (1..=120)
        .map(|id| json!({"id":id,"tag_name":format!("v{id}"),"draft":false,"prerelease":false,"published_at":null,"assets":[]}))
        .collect();
    let (_, coverage, summaries, selected) = github
        .provider
        .catalog_download_options("owner/game", None, ReleaseChannel::Beta, None)
        .await
        .unwrap();
    assert_eq!(selected, Some(1));
    assert_eq!(summaries.len(), 10);
    assert!(!coverage.release_history_complete);
    assert_eq!(github.requests.load(Ordering::SeqCst), 4);
}

#[tokio::test]
async fn bounded_discovery_does_not_claim_no_assets_when_older_releases_are_unchecked() {
    let github = GithubFixture::new(archive(), None, None);
    let older_asset = github.assets.lock().unwrap()[0].clone();
    github.assets.lock().unwrap().clear();
    *github.releases.lock().unwrap() = (1..=11)
        .map(|id| json!({"id":id,"tag_name":format!("v{id}"),"draft":false,"prerelease":false,"published_at":null,"assets":[]}))
        .collect();
    github
        .release_assets
        .lock()
        .unwrap()
        .insert(11, vec![older_asset]);

    let (candidates, coverage, _, _) = github
        .provider
        .catalog_download_options("owner/game", None, ReleaseChannel::Stable, None)
        .await
        .unwrap();
    assert!(candidates.is_empty());
    assert_eq!(coverage.releases_checked, 1);
    assert!(!coverage.release_history_complete);
    assert!(coverage.candidates_complete);
    let reason = coverage.reason(true).unwrap();
    assert!(reason.contains("in the recent releases checked here"));
    assert!(reason.contains("Older downloads may be available"));
    // One release page and the selected complete empty inventory. The older package
    // remains outside the bounded query, not asserted absent.
    assert_eq!(github.requests.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn selection_inspects_one_release_instead_of_combining_packages_across_history() {
    let github = GithubFixture::new(archive(), None, None);
    let asset = github.assets.lock().unwrap()[0].clone();
    *github.assets.lock().unwrap() = (1..=75)
        .map(|id| {
            let mut value = asset.clone();
            value["id"] = json!(id);
            value["name"] = json!(format!("game-{id}.zip"));
            value
        })
        .collect();
    *github.releases.lock().unwrap() = (7..=9)
        .map(|id| json!({"id":id,"tag_name":format!("v{id}"),"draft":false,"prerelease":false,"published_at":null,"assets":[]}))
        .collect();

    let (candidates, coverage, _, _) = github
        .provider
        .catalog_download_options("owner/game", None, ReleaseChannel::Stable, None)
        .await
        .unwrap();
    assert_eq!(candidates.len(), 75);
    assert_eq!(coverage.releases_checked, 1);
    assert!(coverage.release_history_complete);
    assert!(coverage.candidates_complete);
    assert!(coverage.reason(false).is_none());
    assert_eq!(candidates.last().unwrap().release_id, 7);
    assert_eq!(github.requests.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn discovery_completeness_requires_the_end_of_each_selected_asset_inventory() {
    for count in [1, 200, 201] {
        let github = GithubFixture::new(archive(), None, None);
        let asset = github.assets.lock().unwrap()[0].clone();
        *github.assets.lock().unwrap() = (1..=count)
            .map(|id| {
                let mut value = asset.clone();
                value["id"] = json!(id);
                value["name"] = json!(format!("game-{id}.zip"));
                value
            })
            .collect();
        let result = github
            .provider
            .catalog_download_options("owner/game", None, ReleaseChannel::Stable, None)
            .await;
        if count > 200 {
            assert!(
                result
                    .unwrap_err()
                    .message
                    .contains("complete 200-asset inventory bound")
            );
        } else {
            let (candidates, coverage, _, _) = result.unwrap();
            assert_eq!(candidates.len(), count);
            assert_eq!(coverage.releases_checked, 1);
            assert!(coverage.release_history_complete);
            assert!(coverage.candidates_complete);
            assert!(coverage.reason(false).is_none());
        }
    }
}

#[tokio::test]
async fn download_without_published_digest_retains_honest_provenance_and_non_owning_handoff() {
    let (_temporary, service, request) = fixture();
    let bytes = archive();
    let expected = crate::signed_catalog::digest(&bytes);
    let github = GithubFixture::new(bytes, None, None);
    let preview = service
        .catalog_download_preview_with_provider(&request, &github.provider)
        .await
        .unwrap();
    assert!(preview.artifact.sha256.is_none());
    let pending = service
        .download_catalog_package_with_provider(
            &request,
            &preview.preview_sha256,
            |_| {},
            &github.provider,
        )
        .await
        .unwrap();
    assert_eq!(pending.state, PendingSetupState::Downloaded);
    assert_eq!(pending.archive_sha256, expected);
    assert!(pending.artifact.sha256.is_none());
    assert!(pending.path.join("readme.txt").is_file());
    assert_eq!(
        service
            .pending_setup_folder(&pending.port_id, &pending.id)
            .unwrap(),
        pending.path
    );
    assert!(service.library.all_installs().unwrap().is_empty());
    assert!(service.require_no_pending_setup(&pending.port_id).is_err());
    let reopened = PortcoveService::new(service.library.clone()).unwrap();
    assert!(reopened.catalog.listing(&pending.port_id).is_err());
    let snapshot = reopened.workspace_snapshot(10).unwrap();
    assert_eq!(
        snapshot.pending_setups.as_slice(),
        std::slice::from_ref(&pending)
    );
    assert!(
        snapshot
            .listing_catalog
            .unwrap()
            .listings
            .iter()
            .any(|listing| listing.id == pending.port_id)
    );
    assert!(
        reopened
            .artwork(&pending.port_id, crate::ArtworkSlot::Cover)
            .is_ok()
    );
    fs::write(pending.path.join("player-save.dat"), b"my save").unwrap();
    assert!(
        reopened
            .forget_pending_setup(&pending.port_id, "stale-id")
            .is_err()
    );
    reopened
        .forget_pending_setup(&pending.port_id, &pending.id)
        .unwrap();
    assert!(reopened.pending_setups().unwrap().is_empty());
    assert_eq!(
        fs::read(pending.path.join("player-save.dat")).unwrap(),
        b"my save"
    );
    assert!(pending.path.join("readme.txt").exists());
}

#[tokio::test]
async fn complete_asset_endpoint_supplies_checksum_and_conflicts_fail_before_publication() {
    let (_temporary, service, request) = fixture();
    let bytes = archive();
    let hash = crate::signed_catalog::digest(&bytes);
    let github = GithubFixture::new(bytes.clone(), None, Some(format!("{hash}  game.zip\n")));
    let preview = service
        .catalog_download_preview_with_provider(&request, &github.provider)
        .await
        .unwrap();
    assert_eq!(preview.artifact.sha256.as_deref(), Some(hash.as_str()));
    github.assets.lock().unwrap()[0]["digest"] = json!(format!("sha256:{}", "0".repeat(64)));
    assert!(
        service
            .catalog_download_preview_with_provider(&request, &github.provider)
            .await
            .is_err()
    );
    assert!(service.pending_setups().unwrap().is_empty());
    assert!(!preview.destination_path.exists());
}

#[tokio::test]
async fn checksum_mismatch_and_cancellation_never_publish_a_setup_folder() {
    let (_temporary, service, request) = fixture();
    let github = GithubFixture::new(archive(), Some(format!("sha256:{}", "0".repeat(64))), None);
    let preview = service
        .catalog_download_preview_with_provider(&request, &github.provider)
        .await
        .unwrap();
    let error = service
        .download_catalog_package_with_provider(
            &request,
            &preview.preview_sha256,
            |_| {},
            &github.provider,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, crate::ErrorCode::Verification);
    assert!(!preview.destination_path.exists());
    let pending = service.pending_setups().unwrap().pop().unwrap();
    assert_eq!(pending.state, PendingSetupState::AttentionRequired);
    assert!(
        service
            .pending_setup_folder(&pending.port_id, &pending.id)
            .is_err()
    );
    service
        .forget_pending_setup(&pending.port_id, &pending.id)
        .unwrap();
    github.assets.lock().unwrap()[0]["digest"] = Value::Null;
    let preview = service
        .catalog_download_preview_with_provider(&request, &github.provider)
        .await
        .unwrap();
    let mut requested = false;
    let error = service
        .download_catalog_package_with_provider(
            &request,
            &preview.preview_sha256,
            |event| {
                if !requested && matches!(event.event, crate::OperationEventKind::Progress { .. }) {
                    service.request_cancellation(&event.operation_id).unwrap();
                    requested = true;
                }
            },
            &github.provider,
        )
        .await
        .unwrap_err();
    assert!(requested);
    assert_eq!(error.code, crate::ErrorCode::Cancelled);
    assert!(!preview.destination_path.exists());
    assert!(
        !fs::read_dir(&request.destination_parent)
            .unwrap()
            .any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".portcove-download-"))
    );
}

#[tokio::test]
async fn stale_review_and_occupied_or_library_destination_are_refused() {
    let (_temporary, service, mut request) = fixture();
    let github = GithubFixture::new(archive(), None, None);
    let preview = service
        .catalog_download_preview_with_provider(&request, &github.provider)
        .await
        .unwrap();
    github.assets.lock().unwrap()[0]["name"] = json!("renamed.zip");
    assert!(
        service
            .download_catalog_package_with_provider(
                &request,
                &preview.preview_sha256,
                |_| {},
                &github.provider
            )
            .await
            .is_err()
    );
    assert!(service.pending_setups().unwrap().is_empty());
    fs::create_dir(&preview.destination_path).unwrap();
    fs::write(preview.destination_path.join("keep.txt"), b"keep").unwrap();
    assert!(
        service
            .catalog_download_preview_with_provider(&request, &github.provider)
            .await
            .is_err()
    );
    assert_eq!(
        fs::read(preview.destination_path.join("keep.txt")).unwrap(),
        b"keep"
    );
    request.destination_parent = service.library.root().to_path_buf();
    let before = github.requests.load(Ordering::SeqCst);
    assert!(
        service
            .catalog_download_preview_with_provider(&request, &github.provider)
            .await
            .is_err()
    );
    assert_eq!(github.requests.load(Ordering::SeqCst), before);
}

fn intent(
    service: &PortcoveService,
    request: &CatalogDownloadRequest,
) -> (PendingSetupRecord, tempfile::TempDir, String) {
    let stage = tempfile::Builder::new()
        .prefix(".portcove-download-")
        .tempdir_in(&request.destination_parent)
        .unwrap();
    let record = PendingSetupRecord {
        id: Uuid::new_v4().to_string(),
        port_id: request.port_id.clone(),
        listing: service.catalog.listing(&request.port_id).unwrap().clone(),
        path: service.download_destination(request).unwrap(),
        state: PendingSetupState::AttentionRequired,
        artifact: CatalogDownloadCandidate {
            release_id: request.release_id,
            asset_id: request.asset_id,
            release_tag: "v1".into(),
            release_url: "https://github.com/owner/game/releases/tag/v1".into(),
            name: "game.zip".into(),
            size: 1,
            download_url: "https://github.com/owner/game/releases/download/v1/game.zip".into(),
            sha256: None,
            can_extract: true,
        },
        archive_sha256: "a".repeat(64),
        downloaded_at: "2026-10-22T00:00:00Z".into(),
        reason: None,
    };
    let review = "b".repeat(64);
    service
        .insert_catalog_download(&record, stage.path(), &review, &Uuid::new_v4().to_string())
        .unwrap();
    service
        .update_catalog_download(&record, "publication-intent", false)
        .unwrap();
    (record, stage, review)
}

#[test]
fn pending_record_writers_bound_utf8_bytes_and_preserve_readable_rows() {
    let (_temporary, service, request) = fixture();
    let (record, stage, review) = intent(&service, &request);
    let mut oversized = record.clone();
    let unicode = "界".repeat(1300);
    oversized.listing.summary = unicode.clone();
    oversized.listing.manual_setup = Some(
        serde_json::from_value(json!({
            "steps": (0..8).map(|_| json!({"title":"Setup", "instruction":unicode})).collect::<Vec<_>>(),
            "warnings": vec![unicode; 8]
        }))
        .unwrap(),
    );
    validate_record(&oversized).unwrap();
    let json = serde_json::to_string(&oversized).unwrap();
    assert!(json.len() > RECORD_LIMIT);
    assert!(json.chars().count() < RECORD_LIMIT);
    assert!(
        service
            .insert_catalog_download(
                &oversized,
                stage.path(),
                &review,
                &Uuid::new_v4().to_string()
            )
            .unwrap_err()
            .message
            .contains("UTF-8 byte limit")
    );
    assert!(
        service
            .update_catalog_download(&oversized, "attention-required", false)
            .is_err()
    );
    // The schema uses byte length too, rather than SQLite's character count.
    assert!(
        service
            .library
            .connection()
            .unwrap()
            .execute(
                "UPDATE catalog_downloads SET record_json=?1 WHERE port_id=?2",
                params![json, record.port_id],
            )
            .is_err()
    );
    assert_eq!(service.pending_setups().unwrap(), vec![record.clone()]);

    let mut boundary = oversized;
    boundary.listing.summary = "s".repeat(3900);
    let guide = boundary.listing.manual_setup.as_mut().unwrap();
    for step in &mut guide.steps {
        step.instruction = "i".repeat(3500);
    }
    guide.warnings = vec!["w".repeat(3500); 8];
    boundary.reason = Some(String::new());
    let remaining = RECORD_LIMIT - serde_json::to_string(&boundary).unwrap().len();
    assert!(remaining < 8192);
    boundary.reason = Some("r".repeat(remaining));
    assert_eq!(
        encoded_download_record(&boundary).unwrap().len(),
        RECORD_LIMIT
    );
    service
        .update_catalog_download(&boundary, "attention-required", false)
        .unwrap();
    assert_eq!(service.pending_setups().unwrap(), vec![boundary.clone()]);
    let mut one_byte_more = boundary.clone();
    one_byte_more.reason.as_mut().unwrap().push('r');
    assert!(
        service
            .update_catalog_download(&one_byte_more, "attention-required", false)
            .is_err()
    );
    assert_eq!(service.pending_setups().unwrap(), vec![boundary]);
}

#[test]
fn pending_storage_capacity_counts_insertions_and_replacements_in_bytes() {
    // Exercise the storage inventory bounds independently of the semantic record
    // validator, with one writer transaction for each projected replacement.
    let mut connection = rusqlite::Connection::open_in_memory().unwrap();
    connection
        .execute_batch(
            "CREATE TABLE catalog_downloads(port_id TEXT PRIMARY KEY, record_json TEXT NOT NULL)",
        )
        .unwrap();
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .unwrap();
    let full = format!("\"{}\"", "x".repeat(RECORD_LIMIT - 2));
    for index in 0..TOTAL_RECORD_BYTES / RECORD_LIMIT {
        transaction
            .execute(
                "INSERT INTO catalog_downloads VALUES(?1,?2)",
                params![index.to_string(), full],
            )
            .unwrap();
    }
    assert!(require_download_record_capacity(&transaction, "another", "{}").is_err());
    assert!(require_download_record_capacity(&transaction, "0", &full).is_ok());
    transaction
        .execute("DELETE FROM catalog_downloads WHERE port_id='0'", [])
        .unwrap();
    assert!(require_download_record_capacity(&transaction, "another", &full).is_ok());
    assert!(
        require_download_record_capacity(&transaction, "another", &(full.clone() + " ")).is_err()
    );
    transaction
        .execute("DELETE FROM catalog_downloads", [])
        .unwrap();
    for index in 0..RECORDS_LIMIT {
        transaction
            .execute(
                "INSERT INTO catalog_downloads VALUES(?1,'{}')",
                [index.to_string()],
            )
            .unwrap();
    }
    assert!(require_download_record_capacity(&transaction, "another", "{}").is_err());
    assert!(require_download_record_capacity(&transaction, "0", "{}").is_ok());
}

#[test]
fn restart_finishes_proven_handoff_but_never_adopts_or_deletes_a_collision() {
    let (_temporary, service, request) = fixture();
    let (record, stage, review) = intent(&service, &request);
    let payload = stage.path().join("payload");
    fs::create_dir(&payload).unwrap();
    fs::write(payload.join("game.dat"), b"downloaded").unwrap();
    crate::durability::write_json_atomically(
        &payload.join(RECEIPT_NAME),
        &PublicationReceipt {
            format_version: 1,
            pending_id: record.id.clone(),
            port_id: record.port_id.clone(),
            preview_sha256: review,
            archive_sha256: record.archive_sha256.clone(),
        },
        false,
    )
    .unwrap();
    crate::durability::rename_noreplace(&payload, &record.path).unwrap();
    drop(stage);
    let reopened = PortcoveService::new(service.library.clone()).unwrap();
    let completed = reopened.pending_setups().unwrap().pop().unwrap();
    assert_eq!(completed.state, PendingSetupState::Downloaded);
    assert_eq!(completed.archive_sha256, record.archive_sha256);
    reopened
        .forget_pending_setup(&record.port_id, &record.id)
        .unwrap();
    // A different operation with an occupied destination cannot interpret those
    // existing user bytes as its own published folder, even on restart.
    let mut another = request.clone();
    another.asset_id = 22;
    let (other, stage, _) = intent(&service, &another);
    fs::create_dir(&other.path).unwrap();
    fs::write(other.path.join("keep.dat"), b"mine").unwrap();
    drop(stage);
    let reopened = PortcoveService::new(service.library.clone()).unwrap();
    let held = reopened.pending_setups().unwrap().pop().unwrap();
    assert_eq!(held.state, PendingSetupState::AttentionRequired);
    assert!(
        reopened
            .pending_setup_folder(&other.port_id, &other.id)
            .is_err()
    );
    reopened
        .forget_pending_setup(&other.port_id, &other.id)
        .unwrap();
    assert_eq!(fs::read(other.path.join("keep.dat")).unwrap(), b"mine");
    assert_eq!(
        fs::read(record.path.join("game.dat")).unwrap(),
        b"downloaded"
    );
}

#[test]
fn continuation_registration_uses_retained_listing_and_consumes_only_matching_pending_identity() {
    let (_temporary, mut service, request) = fixture();
    let (record, stage, _) = intent(&service, &request);
    // Upstream's native installer can place the executable elsewhere. The
    // explicit user intent binds that exact executable and CWD, not an inferred
    // relationship to the downloaded package's folder.
    let working = request.destination_parent.join("upstream-installed");
    fs::create_dir(&working).unwrap();
    let executable = crate::test_fixture::build_probe(&working);
    fs::write(working.join("save.dat"), b"mine").unwrap();
    let preview = service
        .preview_user_selected_runtime(&record.port_id, &executable, &working, &[])
        .unwrap();
    let authorization = service
        .authorize_user_selected_runtime(
            &record.port_id,
            &executable,
            &working,
            &[],
            &preview.preview_sha256,
        )
        .unwrap();
    service
        .forget_pending_setup(&record.port_id, &record.id)
        .unwrap();
    let (replacement, replacement_stage, _) = intent(&service, &request);
    assert!(
        service
            .register_user_selected_runtime(
                &record.port_id,
                &executable,
                &working,
                &[],
                &authorization.token
            )
            .is_err()
    );
    assert_eq!(service.pending_setups().unwrap()[0].id, replacement.id);
    service.catalog =
        Catalog::from_json(r#"{"schema_version":1,"source_profiles":[],"ports":[]}"#).unwrap();
    let preview = service
        .preview_user_selected_runtime(&record.port_id, &executable, &working, &[])
        .unwrap();
    let authorization = service
        .authorize_user_selected_runtime(
            &record.port_id,
            &executable,
            &working,
            &[],
            &preview.preview_sha256,
        )
        .unwrap();
    let selected = service
        .register_user_selected_runtime(
            &record.port_id,
            &executable,
            &working,
            &[],
            &authorization.token,
        )
        .unwrap();
    assert_eq!(selected.port_id, record.port_id);
    assert!(service.pending_setups().unwrap().is_empty());
    assert!(service.library.all_installs().unwrap().is_empty());
    assert_eq!(fs::read(working.join("save.dat")).unwrap(), b"mine");
    assert!(executable.exists());
    assert!(stage.path().exists() && replacement_stage.path().exists());
}

#[test]
fn workspace_retains_legacy_registered_description_without_new_listing_revalidation() {
    let (_temporary, service, request) = fixture();
    let platform = serde_json::to_value(Platform::current().unwrap())
        .unwrap()
        .as_str()
        .unwrap()
        .to_owned();
    let legacy = Catalog::from_json(&json!({
        "schema_version":1,"source_profiles":[],"ports":[{
            "id":"retained-legacy-listing","name":"Legacy selected runtime","summary":"",
            "project_url":"https://example.com/upstream","support_tier":"beta","channels":["stable"],
            "platforms":[Platform::current().unwrap()],"adapter":"staged-source-portable",
            "release":{"provider":"user-prepared","user_prepared":{
                (platform):{"trust":"user-selected","version":"user-managed","archive_name":"","archive_size":0,
                    "archive_sha256":"","immutable_tree_sha256":"","executable":"","mutable_paths":[]}
            }}
        }]
    }).to_string()).unwrap();
    let record = ExternalRuntimeRecord {
        id: Uuid::new_v4().to_string(),
        port_id: "retained-legacy-listing".into(),
        path: request.destination_parent,
        executable: std::env::current_exe().unwrap(),
        version: "user-managed".into(),
        platform: Platform::current().unwrap(),
        archive_sha256: String::new(),
        immutable_tree_sha256: String::new(),
        registered_at: Library::now(),
        retained_definition: None,
        shared_preferences: None,
        user_selected: Some(crate::UserSelectedLaunch { arguments: vec![] }),
    };
    service
        .library
        .register_external_runtime(&record, &legacy)
        .unwrap();
    let snapshot = service.workspace_snapshot(10).unwrap();
    assert!(
        snapshot
            .listing_catalog
            .unwrap()
            .listings
            .iter()
            .find(|listing| listing.id == record.port_id)
            .unwrap()
            .summary
            .is_empty()
    );
    assert!(
        snapshot
            .listing_statuses
            .iter()
            .any(|status| status.port_id == record.port_id
                && status.status.external_runtime.is_some())
    );
}

#[tokio::test]
async fn replacement_download_keeps_current_registration_until_reviewed_relink() {
    let started = std::time::Instant::now();
    let (temporary, service, request) = fixture();
    let old_root = temporary.path().join("current-copy");
    fs::create_dir(&old_root).unwrap();
    let old_executable = crate::test_fixture::build_probe(&old_root);
    fs::write(old_root.join("player-save.dat"), b"current progress").unwrap();
    let preview = service
        .preview_user_selected_runtime(&request.port_id, &old_executable, &old_root, &[])
        .unwrap();
    let authorization = service
        .authorize_user_selected_runtime(
            &request.port_id,
            &old_executable,
            &old_root,
            &[],
            &preview.preview_sha256,
        )
        .unwrap();
    let original = service
        .register_user_selected_runtime(
            &request.port_id,
            &old_executable,
            &old_root,
            &[],
            &authorization.token,
        )
        .unwrap();
    eprintln!("replacement fixture: registered at {:?}", started.elapsed());
    let before_download = service
        .preview_user_selected_runtime_relink(&request.port_id, &old_executable, &old_root, &[])
        .unwrap();
    let github = GithubFixture::new(archive(), None, None);
    let download = service
        .catalog_download_preview_with_provider(&request, &github.provider)
        .await
        .unwrap();
    let pending = service
        .download_catalog_package_with_provider(
            &request,
            &download.preview_sha256,
            |_| {},
            &github.provider,
        )
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(
            service
                .library
                .status(&request.port_id, ReleaseChannel::Stable)
                .unwrap()
                .external_runtime
        )
        .unwrap(),
        serde_json::to_value(Some(&original)).unwrap()
    );
    assert!(
        service
            .authorize_user_selected_runtime_relink(
                &request.port_id,
                &old_executable,
                &old_root,
                &[],
                &before_download.preview_sha256,
            )
            .is_err(),
        "a preview predating the pending download cannot consume it"
    );
    eprintln!(
        "replacement fixture: downloaded and stale review refused at {:?}",
        started.elapsed()
    );
    let new_executable = crate::test_fixture::build_probe(&pending.path);
    let replacement = service
        .preview_user_selected_runtime_relink(&request.port_id, &new_executable, &pending.path, &[])
        .unwrap();
    let state = service
        .library
        .external_runtime_relink_state(&request.port_id)
        .unwrap()
        .unwrap();
    assert!(
        service
            .library
            .relink_user_selected_runtime(
                &request.port_id,
                &state.row_sha256,
                &replacement.proposed,
                Some((&pending.id, "wrong pending preimage")),
            )
            .is_err()
    );
    assert_eq!(
        service.pending_setups().unwrap().as_slice(),
        std::slice::from_ref(&pending)
    );
    assert_eq!(
        serde_json::to_value(
            service
                .library
                .status(&request.port_id, ReleaseChannel::Stable)
                .unwrap()
                .external_runtime
        )
        .unwrap(),
        serde_json::to_value(Some(&original)).unwrap()
    );
    let authorization = service
        .authorize_user_selected_runtime_relink(
            &request.port_id,
            &new_executable,
            &pending.path,
            &[],
            &replacement.preview_sha256,
        )
        .unwrap();
    let changed = service
        .relink_user_selected_runtime(
            &request.port_id,
            &new_executable,
            &pending.path,
            &[],
            &authorization.token,
        )
        .unwrap();
    eprintln!("replacement fixture: committed at {:?}", started.elapsed());
    assert_eq!(changed.id, original.id);
    assert_eq!(changed.registered_at, original.registered_at);
    assert_eq!(changed.executable, new_executable);
    assert!(service.pending_setups().unwrap().is_empty());
    assert_eq!(
        fs::read(old_root.join("player-save.dat")).unwrap(),
        b"current progress"
    );
    assert!(old_executable.is_file());
    assert!(pending.path.join("readme.txt").is_file());
    assert!(
        changed.archive_sha256.is_empty(),
        "external replacement is not authenticated ownership"
    );
}

#[tokio::test]
async fn ambermoon_bundled_content_acquisition_hold_keeps_permitted_copy_guide_before_network() {
    assert_embedded_player_download_holds(&["ambermoon-ambermoon-net"]).await;
}

#[tokio::test]
async fn embedded_metroid_prime_excluded_game_sdk_hold_keeps_prepared_guide_before_network() {
    assert_embedded_player_download_holds(&["odrannnn-metroidprimeport"]).await;
}

#[tokio::test]
async fn embedded_re_cherry_selected_component_hold_keeps_prepared_guide_before_network() {
    assert_embedded_player_download_holds(&["lollipop-chainsaw-re-cherry"]).await;
}

// Synthetic first-party bytes exercise the real listing/provider contracts;
// they are not an upstream package, permission or gameplay observation.
async fn assert_embedded_resolved_frontend_download(id: &str, tag: &str, asset_name: &str) {
    let (_temporary, mut service, mut request) = fixture();
    service.catalog = Catalog::embedded().unwrap();
    request.port_id = id.into();
    assert!(service.catalog.port(id).is_err());
    let listing = service.catalog.listing(id).unwrap();
    assert!(listing.manual_setup.is_some());
    assert!(listing.download_block_reason.is_none());
    let repository = crate::release::catalog_download_repository(
        listing
            .release_url
            .as_deref()
            .unwrap_or(&listing.project_url),
    )
    .unwrap();
    let expected_channel = if id == "danielgomesvieira2000-beetle-adventure-racing-recomp" {
        ReleaseChannel::Beta
    } else {
        ReleaseChannel::Stable
    };
    assert_eq!(
        service.catalog_download_channel(id).unwrap(),
        expected_channel
    );
    let bytes = archive();
    let expected = crate::signed_catalog::digest(&bytes);
    let github =
        GithubFixture::for_repository(&repository, bytes, Some(format!("sha256:{expected}")), None);
    github.assets.lock().unwrap()[0]["name"] = json!(asset_name);
    // The actual Beetle release is labelled alpha but is not API-prerelease.
    github.releases.lock().unwrap()[0]["tag_name"] = json!(tag);
    let options = service
        .catalog_download_options_with_provider(id, None, None, Some(&github.provider))
        .await
        .unwrap();
    assert!(options.allowed);
    assert_eq!(options.selected_release_id, Some(7));
    assert_eq!(options.candidates.len(), 1);
    assert_eq!(options.candidates[0].name, asset_name);
    assert_eq!(
        options.candidates[0].sha256.as_deref(),
        Some(expected.as_str())
    );
    let coverage = options.coverage.unwrap();
    assert!(coverage.release_history_complete && coverage.candidates_complete);
    assert_eq!(
        options.recommended_asset_id,
        (Platform::current().unwrap() == Platform::WindowsX86_64).then_some(11)
    );
    assert!(service.pending_setups().unwrap().is_empty());
    let preview = service
        .catalog_download_preview_with_provider(&request, &github.provider)
        .await
        .unwrap();
    assert_eq!(preview.artifact.name, asset_name);
    assert_eq!(preview.artifact.sha256.as_deref(), Some(expected.as_str()));
    assert!(!preview.destination_path.exists());
    let pending = service
        .download_catalog_package_with_provider(
            &request,
            &preview.preview_sha256,
            |_| {},
            &github.provider,
        )
        .await
        .unwrap();
    assert_eq!(pending.port_id, id);
    assert_eq!(pending.state, PendingSetupState::Downloaded);
    assert_eq!(pending.archive_sha256, expected);
    assert_eq!(pending.artifact.sha256.as_deref(), Some(expected.as_str()));
    assert_eq!(
        fs::read(pending.path.join("readme.txt")).unwrap(),
        b"Follow the upstream setup instructions."
    );
    assert_eq!(
        service.pending_setups().unwrap().as_slice(),
        std::slice::from_ref(&pending)
    );
    assert!(service.library.all_installs().unwrap().is_empty());
    assert!(
        service
            .library
            .status(id, expected_channel)
            .unwrap()
            .external_runtime
            .is_none()
    );
    assert!(service.require_no_pending_setup(id).is_err());
    assert!(github.requests.load(Ordering::SeqCst) > 0);
}

#[tokio::test]
async fn dahsidiabdallah_conkerbfdreloaded_resolved_frontend_download_1806() {
    assert_embedded_resolved_frontend_download(
        "dahsidiabdallah-conkerbfdreloaded",
        "v1.4.7",
        "ConkerBFDReloaded-v1.4.7-Windows.zip",
    )
    .await;
}

#[tokio::test]
async fn danielgomesvieira2000_beetle_adventure_racing_recomp_resolved_frontend_download_1800() {
    assert_embedded_resolved_frontend_download(
        "danielgomesvieira2000-beetle-adventure-racing-recomp",
        "v0.4.2-alpha",
        "beetle-adventure-racing-recomp-v0.4.2-alpha-windows-x64.zip",
    )
    .await;
}

#[tokio::test]
async fn body_harvest_recompiled_resolved_frontend_download_1448() {
    assert_embedded_resolved_frontend_download(
        "body-harvest-recompiled",
        "v1.0.0",
        "BodyHarvestRecompiled-v1.0.0-Windows.zip",
    )
    .await;
}

#[tokio::test]
async fn cbfd_recompiled_sciaschi_resolved_frontend_download_1216() {
    assert_embedded_resolved_frontend_download(
        "cbfd-recompiled-sciaschi",
        "V0.1.6",
        "ConkerRecompiled-V0.1.6-Windows.zip",
    )
    .await;
}

#[tokio::test]
async fn snowboard_kids_remaining_component_hold_before_network_1354() {
    assert_embedded_player_download_holds(&["snowboard-kids"]).await;
}

#[tokio::test]
async fn cdlewis_snowboardkids_recomp_remaining_component_hold_before_network_1886() {
    assert_embedded_player_download_holds(&["cdlewis-snowboardkids-recomp"]).await;
}

#[tokio::test]
async fn vidanox_banjotooierecompiled_remaining_component_hold_before_network_1795() {
    assert_embedded_player_download_holds(&["vidanox-banjotooierecompiled"]).await;
}

#[tokio::test]
async fn blast_corps_recompiled_font_hold_before_network_2558() {
    assert_embedded_player_download_holds(&["blast-corps-blastcorps-recompiled"]).await;
}

#[tokio::test]
async fn final_fantasy_tactics_finfantacrecomp_component_hold_before_network_327() {
    assert_embedded_player_download_holds(&["final-fantasy-tactics-finfantacrecomp"]).await;
}

#[tokio::test]
async fn silent_hill_silent_hill_decomp_pc_branch_component_hold_before_network_351() {
    assert_embedded_player_download_holds(&["silent-hill-silent-hill-decomp-pc-branch"]).await;
}

#[tokio::test]
async fn tenchu_stealth_assassins_tenchu_sa_recomp_component_hold_before_network_353() {
    assert_embedded_player_download_holds(&["tenchu-stealth-assassins-tenchu-sa-recomp"]).await;
}

#[tokio::test]
async fn dead_rising_2_case_west_recomp_libxlive_hold_before_network_1122() {
    assert_embedded_player_download_holds(&["dead-rising-2-case-west-recomp"]).await;
}

#[tokio::test]
async fn exit_shared_release_keeps_title_recommendations_distinct_362_363() {
    for (id, expected_id) in [
        ("exit-rexglue-exit-exit1", 11),
        ("exit-2-rexglue-exit-exit2", 12),
    ] {
        let (_temporary, mut service, _request) = fixture();
        service.catalog = Catalog::embedded().unwrap();
        let repository = "FluffyQuack/ReXGlue-EXIT";
        let bytes = archive();
        let expected = crate::signed_catalog::digest(&bytes);
        let github = GithubFixture::for_repository(
            repository,
            bytes,
            Some(format!("sha256:{expected}")),
            None,
        );
        let template = github.assets.lock().unwrap()[0].clone();
        let names = [
            "EXIT1-Recomp.zip",
            "EXIT2-Recomp.zip",
            "rexglue-sdk-0.9.1-linux-amd64.zip",
            "rexglue-sdk-0.9.1-win-amd64.zip",
        ];
        *github.assets.lock().unwrap() = names
            .iter()
            .enumerate()
            .map(|(index, name)| {
                let mut asset = template.clone();
                asset["id"] = json!(11 + index);
                asset["name"] = json!(name);
                asset
            })
            .collect();
        github.releases.lock().unwrap()[0]["tag_name"] = json!("v0.9.1");
        let options = service
            .catalog_download_options_with_provider(id, None, None, Some(&github.provider))
            .await
            .unwrap();
        assert!(options.allowed);
        assert_eq!(options.candidates.len(), 4);
        if Platform::current().unwrap() == Platform::WindowsX86_64 {
            assert_eq!(options.recommended_asset_id, Some(expected_id));
        }
        // Recommendations do not filter the explicit generic-download choices.
        for name in names {
            assert!(options.candidates.iter().any(|asset| asset.name == name));
        }
        assert!(service.pending_setups().unwrap().is_empty());
    }
}

#[tokio::test]
async fn dead_rising_2_case_zero_recomp_libxlive_hold_before_network_1121() {
    assert_embedded_player_download_holds(&["dead-rising-2-case-zero-recomp"]).await;
}

#[tokio::test]
async fn condemned_2_bloodshot_condemned2recomp_component_hold_before_network_361() {
    assert_embedded_player_download_holds(&["condemned-2-bloodshot-condemned2recomp"]).await;
}

#[tokio::test]
async fn silent_hill_downpour_downpourrecomp_component_hold_before_network_358() {
    assert_embedded_player_download_holds(&["silent-hill-downpour-downpourrecomp"]).await;
}

#[tokio::test]
async fn tony_hawks_project_8_recomp_component_hold_before_network_1125() {
    assert_embedded_player_download_holds(&["tony-hawks-project-8-recomp"]).await;
}

#[tokio::test]
async fn sonic_free_riders_recompiled_component_hold_before_network_1450() {
    assert_embedded_player_download_holds(&["sonic-free-riders-recompiled"]).await;
}

#[tokio::test]
async fn unchiga_yu_gi_oh_forbidden_memories_recompiled_component_hold_before_network_1910() {
    assert_embedded_player_download_holds(&["unchiga-yu-gi-oh-forbidden-memories-recompiled"])
        .await;
}

#[tokio::test]
async fn james2doyle_ffta_recomp_component_hold_before_network_2824() {
    assert_embedded_player_download_holds(&["james2doyle-ffta-recomp"]).await;
}

#[tokio::test]
async fn kingdom_hearts_chain_of_memories_gba_rekhcom_component_hold_before_network_2586() {
    assert_embedded_player_download_holds(&["kingdom-hearts-chain-of-memories-gba-rekhcom"]).await;
}

#[tokio::test]
async fn vibecodekun_shantaerecomp_component_hold_before_network_1881() {
    assert_embedded_player_download_holds(&["vibecodekun-shantaerecomp"]).await;
}

#[tokio::test]
async fn x_men_mutant_academy_2_xmen_mutant_academy_2_pc_component_hold_before_network_356() {
    assert_embedded_player_download_holds(&["x-men-mutant-academy-2-xmen-mutant-academy-2-pc"])
        .await;
}

#[tokio::test]
async fn eternal_darkness_sanity_s_requiem_eternal_darkness_recomp_component_hold_before_network_2570()
 {
    assert_embedded_player_download_holds(&[
        "eternal-darkness-sanity-s-requiem-eternal-darkness-recomp",
    ])
    .await;
}

#[tokio::test]
async fn geometry_wars_retro_evolved_2_geometry_wars_2_recompiled_component_hold_before_network_2577()
 {
    assert_embedded_player_download_holds(&[
        "geometry-wars-retro-evolved-2-geometry-wars-2-recompiled",
    ])
    .await;
}

#[tokio::test]
async fn hard_corps_uprising_hard_corps_uprising_recompiled_component_hold_before_network_2581() {
    assert_embedded_player_download_holds(&["hard-corps-uprising-hard-corps-uprising-recompiled"])
        .await;
}

#[tokio::test]
async fn crackdown_crackdown_recompiled_component_hold_before_network_2559() {
    assert_embedded_player_download_holds(&["crackdown-crackdown-recompiled"]).await;
}

#[tokio::test]
async fn crazyriddler_finesthourremastered_component_hold_before_network_2785() {
    assert_embedded_player_download_holds(&["crazyriddler-finesthourremastered"]).await;
}
