use super::*;
use crate::definition_repository::publisher_policy::{self as policy, listing_delivery};
use serde_json::json;

fn feed(revision: u64) -> Value {
    json!({"listing_delivery_schema":1,"revision":revision,"withdrawn_ids":[],
    "directory":{"format_version":1,"listings":[{
        "id":"new-unmanaged-port","name":"New unmanaged port",
        "summary":"Descriptive authenticated fixture; no executable authority.",
        "project_url":"https://example.invalid/project", "availability":"source-only"
    }]}})
}

async fn publish(fixture: &RepositoryFixture, key: &Key, version: u64, feed: &Value) -> Vec<u8> {
    fixture
        .publish_with_policy(
            &[(
                listing_delivery::TARGET.into(),
                serde_json::to_vec(feed).unwrap(),
            )],
            true,
            &DEFINITION_ROLE_PATHS,
            later(),
            Some((key, version)),
        )
        .await
}

async fn refresh(
    library: &Library,
    fixture: &RepositoryFixture,
    root: &[u8],
) -> crate::Result<crate::ListingDeliveryStatus> {
    let service = PortcoveService::new(library.clone()).unwrap();
    let source = DefinitionRepositorySource {
        metadata_base_url: fixture.metadata_url(),
        targets_base_url: fixture.targets_url(),
    };
    listing_delivery::refresh_fixture(&service, &source, root, FilesystemTransport, |_| {}).await
}

fn provision(library: &Library, root: &[u8]) {
    let review = policy::provisioning::review_fixture(library, root).unwrap();
    policy::provisioning::apply_fixture(library, root, &review.expected_plan).unwrap();
}

#[tokio::test]
async fn authenticated_listings_add_correct_withdraw_without_managed_authority() {
    let fixture = authority_provisioning::separated_fixture();
    let key = Key::new(fixture._directory.path());
    let (_temp, library) = library();
    assert!(
        library
            .load_catalog()
            .unwrap()
            .0
            .listing("new-unmanaged-port")
            .is_err()
    );
    let root = publish(&fixture, &key, 1, &feed(1)).await;
    assert!(refresh(&library, &fixture, &root).await.is_err());
    provision(&library, &root);
    assert!(refresh(&library, &fixture, &root).await.unwrap().selected);
    let (catalog, _) = library.load_catalog().unwrap();
    assert_eq!(
        catalog.listing("new-unmanaged-port").unwrap().name,
        "New unmanaged port"
    );
    assert!(catalog.port("new-unmanaged-port").is_err());
    assert_eq!(
        serde_json::to_value(catalog.authoritative_document()).unwrap(),
        serde_json::to_value(Catalog::embedded().unwrap().authoritative_document()).unwrap()
    );
    assert!(
        library
            .definition_selection_status()
            .unwrap()
            .selected
            .is_none()
    );
    assert_eq!(
        refresh(&library, &fixture, &root).await.unwrap().revision,
        Some(1)
    );

    let image_path = _temp.path().join("override.png");
    image::RgbImage::from_pixel(8, 12, image::Rgb([32, 64, 128]))
        .save(&image_path)
        .unwrap();
    let override_state = PortcoveService::new(library.clone())
        .unwrap()
        .import_artwork(
            "new-unmanaged-port",
            crate::ArtworkSlot::Cover,
            &image_path,
            0,
        )
        .unwrap();

    let external = tempfile::tempdir().unwrap();
    let executable = crate::test_fixture::build_probe(external.path());
    let executable_before = fs::read(&executable).unwrap();
    let player_save = external.path().join("player-save.dat");
    fs::write(&player_save, b"retained player save").unwrap();
    let service = PortcoveService::new(library.clone()).unwrap();
    let preview = service
        .preview_user_selected_runtime("new-unmanaged-port", &executable, external.path(), &[])
        .unwrap();
    let authorization = service
        .authorize_user_selected_runtime(
            "new-unmanaged-port",
            &executable,
            external.path(),
            &[],
            &preview.preview_sha256,
        )
        .unwrap();
    let registered = service
        .register_user_selected_runtime(
            "new-unmanaged-port",
            &executable,
            external.path(),
            &[],
            &authorization.token,
        )
        .unwrap();
    let retained_record = serde_json::to_vec(&registered).unwrap();

    let mut corrected = feed(2);
    corrected["directory"]["listings"][0]["name"] = json!("Corrected title");
    corrected["directory"]["listings"][0]["artwork"] = serde_json::to_value(
        Catalog::embedded()
            .unwrap()
            .listing("shipwright")
            .unwrap()
            .artwork
            .clone(),
    )
    .unwrap();
    let root2 = publish(&fixture, &key, 2, &corrected).await;
    refresh(&library, &fixture, &root2).await.unwrap();
    let (catalog, _) = library.load_catalog().unwrap();
    assert_eq!(
        catalog.listing("new-unmanaged-port").unwrap().name,
        "Corrected title"
    );
    assert!(
        catalog
            .listing("new-unmanaged-port")
            .unwrap()
            .artwork
            .is_some()
    );
    let corrected_art = PortcoveService::new(library.clone())
        .unwrap()
        .artwork("new-unmanaged-port", crate::ArtworkSlot::Cover)
        .unwrap();
    assert_eq!(corrected_art.choice, override_state.choice);
    assert!(matches!(
        corrected_art.resolved_source,
        crate::ArtworkResolvedSource::LocalImport { .. }
    ));
    let tombstones = json!({"listing_delivery_schema":1,"revision":3,
        "withdrawn_ids":["new-unmanaged-port","shipwright"],"directory":{"format_version":1,"listings":[]}});
    let root3 = publish(&fixture, &key, 3, &tombstones).await;
    refresh(&library, &fixture, &root3).await.unwrap();
    let (catalog, _) = library.load_catalog().unwrap();
    assert!(catalog.listing("new-unmanaged-port").is_err());
    assert!(catalog.port("shipwright").is_ok());
    assert!(catalog.listing("shipwright").is_ok());
    let service = PortcoveService::new(library.clone()).unwrap();
    assert!(
        service
            .listing_statuses()
            .unwrap()
            .iter()
            .any(|row| row.port_id == "new-unmanaged-port")
    );
    assert_eq!(
        serde_json::to_vec(
            &library
                .external_runtime_with_port("new-unmanaged-port")
                .unwrap()
                .unwrap()
                .0
        )
        .unwrap(),
        retained_record
    );
    assert_eq!(fs::read(&executable).unwrap(), executable_before);
    assert_eq!(fs::read(&player_save).unwrap(), b"retained player save");
    assert_eq!(
        service
            .artwork("new-unmanaged-port", crate::ArtworkSlot::Cover)
            .unwrap()
            .choice,
        override_state.choice
    );
}

#[tokio::test]
async fn listing_replay_equivocation_and_failed_refresh_preserve_last_selection() {
    let fixture = authority_provisioning::separated_fixture();
    let key = Key::new(fixture._directory.path());
    let (_temp, library) = library();
    let root = publish(&fixture, &key, 1, &feed(1)).await;
    provision(&library, &root);
    refresh(&library, &fixture, &root).await.unwrap();
    let original = library.listing_delivery_status().unwrap().target_sha256;
    let mut changed = feed(1);
    changed["directory"]["listings"][0]["name"] = json!("Same revision substitution");
    let root2 = publish(&fixture, &key, 2, &changed).await;
    assert!(refresh(&library, &fixture, &root2).await.is_err());
    assert_eq!(
        library.listing_delivery_status().unwrap().target_sha256,
        original
    );
    fs::remove_dir_all(&fixture.metadata).unwrap();
    assert!(refresh(&library, &fixture, &root).await.is_err());
    assert!(library.listing_delivery_status().unwrap().selected);
    assert_eq!(
        library
            .load_catalog()
            .unwrap()
            .0
            .listing("new-unmanaged-port")
            .unwrap()
            .name,
        "New unmanaged port"
    );
    let connection = library.connection().unwrap();
    let (fallback, status) =
        listing_delivery::load(&connection, Catalog::embedded().unwrap(), i64::MAX);
    assert!(!status.selected);
    assert!(status.fallback_reason.unwrap().contains("expired"));
    assert!(fallback.listing("new-unmanaged-port").is_err());
    assert_eq!(
        library.listing_delivery_status().unwrap().target_sha256,
        original
    );
}

#[test]
fn listing_target_rejects_execution_fields_duplicates_and_conflicting_withdrawals() {
    let mut operational = feed(1);
    operational["directory"]["listings"][0]["adapter"] = json!("staged-source-portable");
    let mut conflicting = feed(1);
    conflicting["withdrawn_ids"] = json!(["new-unmanaged-port"]);
    let mut unknown = feed(1);
    unknown["listing_delivery_schema"] = json!(2);
    for candidate in [operational, conflicting, unknown, feed(0)] {
        assert!(
            listing_delivery::ListingDeliveryDocument::parse(
                &serde_json::to_vec(&candidate).unwrap()
            )
            .is_err()
        );
    }
    assert!(
        listing_delivery::ListingDeliveryDocument::parse(b"{\"revision\":1,\"revision\":2}")
            .is_err()
    );
}

#[derive(Debug, Clone)]
struct SuspendedListingTransport {
    started: std::sync::Arc<tokio::sync::Notify>,
    active: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}

struct PendingListing(std::sync::Arc<std::sync::atomic::AtomicUsize>);
impl Drop for PendingListing {
    fn drop(&mut self) {
        self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

#[async_trait::async_trait]
impl tough::Transport for SuspendedListingTransport {
    async fn fetch(
        &self,
        url: Url,
    ) -> std::result::Result<tough::TransportStream, tough::TransportError> {
        if url.path().ends_with("catalog.listings.json") {
            self.active
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let _pending = PendingListing(self.active.clone());
            self.started.notify_one();
            std::future::pending::<()>().await;
        }
        tough::Transport::fetch(&FilesystemTransport, url).await
    }
}

#[tokio::test]
async fn cancellation_reaps_listing_acquisition_and_keeps_the_exact_prior_selection() {
    let fixture = authority_provisioning::separated_fixture();
    let key = Key::new(fixture._directory.path());
    let (_temp, library) = library();
    let root = publish(&fixture, &key, 1, &feed(1)).await;
    provision(&library, &root);
    refresh(&library, &fixture, &root).await.unwrap();
    let original = library.listing_delivery_status().unwrap().target_sha256;
    let next_root = publish(&fixture, &key, 2, &feed(2)).await;
    let service = PortcoveService::new(library.clone()).unwrap();
    let source = DefinitionRepositorySource {
        metadata_base_url: fixture.metadata_url(),
        targets_base_url: fixture.targets_url(),
    };
    let started = std::sync::Arc::new(tokio::sync::Notify::new());
    let active = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::<crate::OperationEvent>::new()));
    let operation = listing_delivery::refresh_fixture(
        &service,
        &source,
        &next_root,
        SuspendedListingTransport {
            started: started.clone(),
            active: active.clone(),
        },
        |event| events.lock().unwrap().push(event),
    );
    let cancel = async {
        tokio::time::timeout(std::time::Duration::from_secs(10), started.notified())
            .await
            .unwrap();
        let id = events.lock().unwrap()[0].operation_id.clone();
        service.request_cancellation(&id).unwrap();
    };
    let (result, ()) = tokio::join!(operation, cancel);
    assert_eq!(result.unwrap_err().code, ErrorCode::Cancelled);
    assert_eq!(active.load(std::sync::atomic::Ordering::SeqCst), 0);
    assert_eq!(
        library.listing_delivery_status().unwrap().target_sha256,
        original
    );
    assert_eq!(
        library.activities(1).unwrap()[0].status,
        crate::ActivityStatus::Cancelled
    );
}

#[tokio::test]
async fn authenticated_descriptive_observation_updates_and_failed_refresh_keep_last_good_without_managed_rights()
 {
    let fixture = authority_provisioning::separated_fixture();
    let key = Key::new(fixture._directory.path());
    let (_temp, library) = library();
    let mut initial = feed(1);
    initial["directory"]["listings"][0]["project_url"] = "https://github.com/example/game".into();
    initial["directory"]["listings"][0]["availability"] = "unknown".into();
    let root = publish(&fixture, &key, 1, &initial).await;
    provision(&library, &root);
    refresh(&library, &fixture, &root).await.unwrap();
    let operational =
        serde_json::to_value(library.load_catalog().unwrap().0.authoritative_document()).unwrap();
    let mut observed = initial.clone();
    observed["revision"] = 2.into();
    observed["directory"]["format_version"] = 4.into();
    observed["directory"]["listings"][0]["download_asset_hints"] =
        json!({"windows-x86-64":["windows","x64"]});
    observed["directory"]["listings"][0]["upstream_observation"] = json!({
        "provider":"github","repository":"example/game","repository_id":7,"status":"complete",
        "attempted_at":"2026-10-27T00:01:00Z","observed_at":"2026-10-27T00:00:00Z","fresh_until":"2026-10-27T12:00:00Z",
        "facts_sha256":"a".repeat(64),"release_limit":4,"releases":[{
            "id":11,"version":"v1.2.0","release_url":"https://github.com/example/game/releases/tag/v1.2.0","published_at":"2026-10-26T00:00:00Z",
            "provider_prerelease":false,"assets_complete":true,"assets":[{"id":21,"name":"game-windows-x64.zip","url":"https://github.com/example/game/releases/download/v1.2.0/game-windows-x64.zip","size":42,"sha256":null,"platform_hints":["windows-x86-64"]}]}]});
    let root2 = publish(&fixture, &key, 2, &observed).await;
    refresh(&library, &fixture, &root2).await.unwrap();
    let (catalog, _) = library.load_catalog().unwrap();
    let listing = catalog.listing("new-unmanaged-port").unwrap();
    assert_eq!(
        listing.upstream_observation.as_ref().unwrap().releases[0].assets[0].id,
        21
    );
    assert!(catalog.port("new-unmanaged-port").is_err());
    assert_eq!(
        serde_json::to_value(catalog.authoritative_document()).unwrap(),
        operational
    );
    let mut invalid = observed.clone();
    invalid["revision"] = 3.into();
    invalid["directory"]["listings"][0]["upstream_observation"]["releases"][0]["release_url"] =
        "https://github.com/foreign/game/releases/tag/v1.2.0".into();
    let root3 = publish(&fixture, &key, 3, &invalid).await;
    assert!(refresh(&library, &fixture, &root3).await.is_err());
    // Cached readback by the same compiled code does not require a provider request.
    let (offline, _) = Library::open(library.root())
        .unwrap()
        .load_catalog()
        .unwrap();
    assert_eq!(
        offline
            .listing("new-unmanaged-port")
            .unwrap()
            .upstream_observation,
        listing.upstream_observation
    );
    assert!(offline.port("new-unmanaged-port").is_err());
}
