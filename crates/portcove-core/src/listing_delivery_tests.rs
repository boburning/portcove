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
async fn artwork_snapshot_rechecks_a_withdrawn_cover_on_an_unchanged_receiver() {
    use crate::{
        ArtworkResolvedSource, ArtworkSlot, CompositeReleaseProvider, DestinationArtworkRole,
    };

    let fixture = authority_provisioning::separated_fixture();
    let key = Key::new(fixture._directory.path());
    let (_temp, library) = library();
    let mut first = feed(1);
    first["directory"]["format_version"] = json!(3);
    let listings = first["directory"]["listings"].as_array_mut().unwrap();
    listings[0]["original_game"] = json!({
        "format_version": 1,
        "id": "shared-cover-game",
        "evidence_urls": ["https://example.invalid/game"],
        "source_editions": [{
            "id": "console",
            "title": "Console edition",
            "system": "xbox",
            "evidence_urls": ["https://example.invalid/edition"]
        }]
    });
    let mut donor = listings[0].clone();
    donor["id"] = json!("cover-donor");
    donor["artwork"] = json!({
        "game_id": 1, "cover_id": 2, "image_id": "co1abc",
        "image_sha256": "5".repeat(64), "game_slug": "shared-cover-game",
        "match_kind": "underlying-game"
    });
    listings.push(donor);
    let root = publish(&fixture, &key, 1, &first).await;
    provision(&library, &root);
    assert!(refresh(&library, &fixture, &root).await.unwrap().selected);

    let receiver = "new-unmanaged-port";
    let releases = std::sync::Arc::new(CompositeReleaseProvider::for_library(&library).unwrap());
    let held =
        PortcoveService::with_provider_for_artwork(library.clone(), releases.clone()).unwrap();
    let before = held.catalog().listing(receiver).unwrap().clone();
    assert!(matches!(
        held.artwork(receiver, ArtworkSlot::Cover)
            .unwrap()
            .resolved_source,
        ArtworkResolvedSource::IgdbCover { .. }
    ));

    first["revision"] = json!(2);
    first["directory"]["listings"][1]
        .as_object_mut()
        .unwrap()
        .remove("artwork");
    let root = publish(&fixture, &key, 2, &first).await;
    assert!(refresh(&library, &fixture, &root).await.unwrap().selected);
    let current = PortcoveService::with_provider_for_artwork(library, releases).unwrap();
    assert_eq!(current.catalog().listing(receiver).unwrap(), &before);
    assert_eq!(
        held.artwork(receiver, ArtworkSlot::Cover).unwrap_err().code,
        crate::ErrorCode::Conflict
    );
    assert_eq!(
        held.destination_artwork(receiver, DestinationArtworkRole::PortraitCover)
            .unwrap_err()
            .code,
        crate::ErrorCode::Conflict
    );
    assert_eq!(
        current
            .artwork(receiver, ArtworkSlot::Cover)
            .unwrap()
            .resolved_source,
        ArtworkResolvedSource::GeneratedFallback
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
    assert_eq!(
        status.fallback_code,
        Some(crate::CatalogFallbackCode::ListingDirectoryUnavailable)
    );
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

#[tokio::test]
async fn authenticated_gitlab_listing_observations_and_unknown_format_recovery_stay_descriptive() {
    let fixture = authority_provisioning::separated_fixture();
    let key = Key::new(fixture._directory.path());
    let (_temp, library) = library();
    let mut candidate = feed(1);
    candidate["directory"]["format_version"] = json!(8);
    let listing = &mut candidate["directory"]["listings"][0];
    listing["project_url"] = json!("https://gitlab.com/example/game");
    let advice = json!({"format_version":99,"future":true});
    listing["compatibility"] = advice.clone();
    listing["upstream_observation"] = json!({
        "provider":"gitlab","repository":"example/game","repository_id":7,
        "status":"complete","attempted_at":"2026-10-27T00:01:00Z",
        "observed_at":"2026-10-27T00:00:00Z","fresh_until":"2026-10-27T12:00:00Z",
        "facts_sha256":"a".repeat(64),"release_limit":4,
        "releases":[{"id":{"provider":"gitlab","project_id":7,"tag":"v1"},"version":"v1","release_url":"https://gitlab.com/example/game/-/releases/v1",
            "published_at":"2026-10-26T00:00:00Z","provider_prerelease":false,"assets_complete":true,"assets":[]}]
    });
    let root = publish(&fixture, &key, 1, &candidate).await;
    provision(&library, &root);
    assert!(refresh(&library, &fixture, &root).await.unwrap().selected);
    let original = library.listing_delivery_status().unwrap().target_sha256;
    let (catalog, _) = library.load_catalog().unwrap();
    // Embedded typed IGDB scenes require format 13 in the combined directory.
    assert_eq!(catalog.listing_document().format_version, 13);
    assert_eq!(
        catalog
            .listing("new-unmanaged-port")
            .unwrap()
            .compatibility
            .as_ref(),
        Some(&advice)
    );
    assert_eq!(
        catalog
            .listing("new-unmanaged-port")
            .unwrap()
            .upstream_observation
            .as_ref()
            .unwrap()
            .provider,
        "gitlab"
    );
    assert!(catalog.port("new-unmanaged-port").is_err());
    candidate["revision"] = json!(2);
    // The next unknown format follows the accepted IGDB scene format 13.
    candidate["directory"]["format_version"] = json!(14);
    let next_root = publish(&fixture, &key, 2, &candidate).await;
    assert!(refresh(&library, &fixture, &next_root).await.is_err());
    assert_eq!(
        library.listing_delivery_status().unwrap().target_sha256,
        original
    );
    assert_eq!(
        library
            .load_catalog()
            .unwrap()
            .0
            .listing_document()
            .format_version,
        catalog.listing_document().format_version
    );
}

#[tokio::test]
async fn a_delivered_format_nine_directory_replaces_its_own_records_over_funded_embedded_listings()
{
    let fixture = authority_provisioning::separated_fixture();
    let key = Key::new(fixture._directory.path());
    let (_temp, library) = library();
    let embedded = Catalog::embedded().unwrap();
    assert!(
        embedded
            .listing("severed-chains")
            .unwrap()
            .funding_urls
            .is_some()
    );
    // A format-9 snapshot (no funding links) that corrects one funded embedded record.
    let mut corrected = serde_json::to_value(embedded.listing("severed-chains").unwrap()).unwrap();
    corrected.as_object_mut().unwrap().remove("funding_urls");
    corrected["summary"] = json!("Corrected descriptive summary.");
    let mut candidate = feed(1);
    candidate["directory"]["format_version"] = json!(9);
    candidate["directory"]["listings"]
        .as_array_mut()
        .unwrap()
        .push(corrected);
    let root = publish(&fixture, &key, 1, &candidate).await;
    provision(&library, &root);
    assert!(refresh(&library, &fixture, &root).await.unwrap().selected);
    let (catalog, _) = library.load_catalog().unwrap();
    // Snapshot replacement: the delivered record carries no links, so none are shown for it.
    let replaced = catalog.listing("severed-chains").unwrap();
    assert_eq!(replaced.summary, "Corrected descriptive summary.");
    assert!(replaced.funding_urls.is_none());
    // Omitted bundled records keep their metadata, including format-11 collections.
    assert!(
        catalog
            .listing("ambermoon-ambermoon-net")
            .unwrap()
            .funding_urls
            .is_some()
    );
    assert_eq!(catalog.listing_document().format_version, 13);

    // A delivered format-10 snapshot carries links for this reader.
    candidate["revision"] = json!(2);
    candidate["directory"]["format_version"] = json!(10);
    candidate["directory"]["listings"][1]["funding_urls"] = json!(["https://ko-fi.com/example"]);
    let next_root = publish(&fixture, &key, 2, &candidate).await;
    assert!(
        refresh(&library, &fixture, &next_root)
            .await
            .unwrap()
            .selected
    );
    let (catalog, _) = library.load_catalog().unwrap();
    assert_eq!(
        catalog
            .listing("severed-chains")
            .unwrap()
            .funding_urls
            .as_deref(),
        Some(&["https://ko-fi.com/example".to_owned()][..])
    );
}

/// Owner decision on #534 (2026-11-15): official catalog updates are on by
/// default, refresh quietly, never overlap and keep prior state on failure.
/// One test owns the process-wide refresh guard so parallel tests cannot race it.
#[tokio::test]
async fn automatic_official_refresh_defaults_on_stays_quiet_and_preserves_state() {
    use crate::OfficialCatalogAutomaticOutcome as Outcome;
    use policy::provisioning::official_catalog::{
        automatic_refresh_fixture, hold_refresh_guard_fixture, serialize_automatic_refresh_fixtures,
    };
    let _fixtures = serialize_automatic_refresh_fixtures().await;
    const SOURCE: &[u8] = br#"{"metadata_base_url":"https://catalog.invalid/metadata/","targets_base_url":"https://catalog.invalid/targets/"}"#;
    let fixture = authority_provisioning::separated_fixture();
    let key = Key::new(fixture._directory.path());
    let root = authority_provisioning::single_owner_root(&fixture).await;
    let (_temp, library) = library();
    let host = tempfile::tempdir().unwrap();
    let preferences =
        crate::HostPreferenceStore::new(host.path().join("preferences.json")).unwrap();
    let service = PortcoveService::new(library.clone()).unwrap();
    let repository = DefinitionRepositorySource {
        metadata_base_url: fixture.metadata_url(),
        targets_base_url: fixture.targets_url(),
    };
    let installed =
        |library: &Library| policy::provisioning::review_single_owner_fixture(library, &root);
    let observer = library.connection().unwrap();

    // An explicit off persists and stops the schedule before any trust, I/O or write.
    preferences
        .set_official_catalog_automatic_updates(false)
        .unwrap();
    let before = authority_provisioning::data_version(&observer);
    let off = automatic_refresh_fixture(
        &service,
        &preferences,
        &root,
        SOURCE,
        &repository,
        FilesystemTransport,
    )
    .await
    .unwrap();
    assert_eq!(off.outcome, Outcome::TurnedOff);
    assert!(!installed(&library).unwrap().installed);
    assert_eq!(authority_provisioning::data_version(&observer), before);

    // On (the default once the choice is cleared), nothing published yet: the
    // compiled anchor is installed from Core's own reviewed plan, and the
    // absent metadata is a quiet "not served" with no activity or selection.
    preferences
        .set_official_catalog_automatic_updates(true)
        .unwrap();
    let unpublished = automatic_refresh_fixture(
        &service,
        &preferences,
        &root,
        SOURCE,
        &repository,
        FilesystemTransport,
    )
    .await
    .unwrap();
    assert_eq!(unpublished.outcome, Outcome::Unavailable);
    assert_eq!(
        unpublished.serving,
        Some(crate::DefinitionDeliveryServing::NotServed)
    );
    assert!(installed(&library).unwrap().installed);
    assert!(library.activities(10).unwrap().is_empty());
    assert!(
        library
            .listing_delivery_status()
            .unwrap()
            .revision
            .is_none()
    );

    // Published: the existing authenticated listing delivery selects it.
    publish(&fixture, &key, 1, &feed(1)).await;
    let refreshed = automatic_refresh_fixture(
        &service,
        &preferences,
        &root,
        SOURCE,
        &repository,
        FilesystemTransport,
    )
    .await
    .unwrap();
    assert_eq!(refreshed.outcome, Outcome::Refreshed);
    assert_eq!(refreshed.status.unwrap().revision, Some(1));
    let selected = |library: &Library| {
        library
            .load_catalog()
            .unwrap()
            .0
            .listing("new-unmanaged-port")
            .is_ok()
    };
    assert!(selected(&library));
    let activities = library.activities(10).unwrap().len();

    // A refresh already in progress makes the scheduled one skip, not overlap.
    {
        let _running = hold_refresh_guard_fixture().await;
        let skipped = automatic_refresh_fixture(
            &service,
            &preferences,
            &root,
            SOURCE,
            &repository,
            FilesystemTransport,
        )
        .await
        .unwrap();
        assert_eq!(skipped.outcome, Outcome::AlreadyRunning);
    }

    // A verified publication this client refuses (here, changed bytes at the
    // same listing revision) is quiet too: no failed activity, selection kept.
    let mut equivocation = feed(1);
    equivocation["directory"]["listings"][0]["name"] = json!("Equivocated title");
    publish(&fixture, &key, 2, &equivocation).await;
    let refused = automatic_refresh_fixture(
        &service,
        &preferences,
        &root,
        SOURCE,
        &repository,
        FilesystemTransport,
    )
    .await
    .unwrap();
    assert_eq!(refused.outcome, Outcome::Unavailable);
    assert_eq!(
        refused.serving,
        Some(crate::DefinitionDeliveryServing::VerificationFailed)
    );
    assert_eq!(library.activities(10).unwrap().len(), activities);
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

    // Tampered metadata and an outage both keep the accepted selection.
    let timestamp = fixture.metadata.join("timestamp.json");
    let signed = fs::read(&timestamp).unwrap();
    fs::write(&timestamp, b"{\"signed\":{}}").unwrap();
    let tampered = automatic_refresh_fixture(
        &service,
        &preferences,
        &root,
        SOURCE,
        &repository,
        FilesystemTransport,
    )
    .await
    .unwrap();
    assert_eq!(tampered.outcome, Outcome::Unavailable);
    assert_eq!(
        tampered.serving,
        Some(crate::DefinitionDeliveryServing::VerificationFailed)
    );
    fs::write(&timestamp, signed).unwrap();
    fs::remove_dir_all(&fixture.metadata).unwrap();
    let outage = automatic_refresh_fixture(
        &service,
        &preferences,
        &root,
        SOURCE,
        &repository,
        FilesystemTransport,
    )
    .await
    .unwrap();
    assert_eq!(outage.outcome, Outcome::Unavailable);
    assert_eq!(library.listing_delivery_status().unwrap().revision, Some(1));
    assert!(selected(&library));
    assert_eq!(library.activities(10).unwrap().len(), activities);
}

#[tokio::test]
async fn signed_shared_observation_reopens_into_offline_preliminary_download_browsing() {
    let fixture = authority_provisioning::separated_fixture();
    let key = Key::new(fixture._directory.path());
    let (_temp, library) = library();
    let now = time::OffsetDateTime::now_utc();
    let stamp = |value: time::OffsetDateTime| {
        value
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap()
    };
    let mut candidate = feed(1);
    candidate["directory"]["format_version"] = json!(4);
    let listing = &mut candidate["directory"]["listings"][0];
    listing["project_url"] = json!("https://github.com/example/game");
    listing["availability"] = json!("unknown");
    listing["upstream_observation"] = json!({
        "provider":"github","repository":"example/game","repository_id":7,"status":"complete",
        "attempted_at":stamp(now),"observed_at":stamp(now-time::Duration::seconds(1)),
        "fresh_until":stamp(now+time::Duration::hours(1)),"facts_sha256":"a".repeat(64),
        "release_limit":4,"releases":[{"id":11,"version":"v1","release_url":"https://github.com/example/game/releases/tag/v1",
        "published_at":"2026-01-01T00:00:00Z","provider_prerelease":false,"assets_complete":true,
        "assets":[{"id":21,"name":"game.zip","url":"https://github.com/example/game/releases/download/v1/game.zip",
        "size":42,"sha256":null,"platform_hints":[]}]}]
    });
    let root = publish(&fixture, &key, 1, &candidate).await;
    provision(&library, &root);
    assert!(refresh(&library, &fixture, &root).await.unwrap().selected);
    // The unchanged consumer reopens retained signed state. This route has no
    // provider transport when its fresh observation satisfies preliminary browse.
    let service = PortcoveService::new(Library::open(library.root()).unwrap()).unwrap();
    let result = service
        .catalog_download_options("new-unmanaged-port", None, crate::ReleaseChannel::Stable)
        .await
        .unwrap();
    assert!(result.allowed);
    assert_eq!(result.selected_release_id, Some(11.into()));
    assert_eq!(
        result.candidates[0].asset_id,
        crate::CatalogDownloadAssetId::from(21_u64)
    );
    assert!(
        result
            .reason
            .unwrap()
            .contains("Upstream metadata observed at")
    );
    assert!(service.catalog().port("new-unmanaged-port").is_err());
}

#[tokio::test]
async fn signed_legacy_observation_directory_preserves_authored_comparison_descriptions_on_reopen()
{
    let fixture = authority_provisioning::separated_fixture();
    let key = Key::new(fixture._directory.path());
    let (_temp, library) = library();
    let embedded = Catalog::embedded().unwrap();
    let ids = ["2ship2harkinian", "zelda64-recomp"];
    let mut legacy = embedded.listing_document().export_format(11).unwrap();
    legacy
        .listings
        .retain(|listing| ids.contains(&listing.id.as_str()));
    assert_eq!(legacy.listings.len(), ids.len());
    assert!(
        legacy
            .listings
            .iter()
            .all(|listing| listing.implementation.is_none())
    );
    let candidate = json!({
        "listing_delivery_schema":1,"revision":1,"withdrawn_ids":[],"directory":legacy
    });
    let root = publish(&fixture, &key, 1, &candidate).await;
    provision(&library, &root);
    assert!(refresh(&library, &fixture, &root).await.unwrap().selected);
    let service = PortcoveService::new(Library::open(library.root()).unwrap()).unwrap();
    for id in ids {
        let original = embedded.listing(id).unwrap();
        assert!(original.implementation.is_some());
        assert_eq!(
            service.catalog().listing(id).unwrap().implementation,
            original.implementation
        );
    }
    assert_eq!(
        serde_json::to_value(service.catalog().authoritative_document()).unwrap(),
        serde_json::to_value(embedded.authoritative_document()).unwrap()
    );
}

#[tokio::test]
async fn observer_produced_target_reaches_signed_cache_and_preliminary_browse_without_a_route_grant()
 {
    // Node's maintained contract recreates these exact bytes through the real
    // projectListingObservation and publication builder, from synthetic provider
    // facts. The fixed source clock is explicit; no fresh/live upstream claim.
    let produced: Value = serde_json::from_str(include_str!(
        "testdata/listing-observation-delivery.generated.json"
    ))
    .unwrap();
    assert_eq!(produced["directory"]["format_version"], 11);
    let fixture = authority_provisioning::separated_fixture();
    let key = Key::new(fixture._directory.path());
    let (_temp, library) = library();
    let root = publish(&fixture, &key, 1, &produced).await;
    provision(&library, &root);
    assert!(refresh(&library, &fixture, &root).await.unwrap().selected);
    let service = PortcoveService::new(Library::open(library.root()).unwrap()).unwrap();
    let listing = service.catalog().listing("new-unmanaged-port").unwrap();
    assert!(
        listing.implementation.is_none(),
        "format-11 readers never meet the new inert key"
    );
    assert!(service.catalog().port("new-unmanaged-port").is_err());
    let provider = crate::GithubReleaseProvider::with_api_root("https://api.github.com").unwrap();
    let at = |value| {
        time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339).unwrap()
    };
    let (candidates, coverage, _, selected) = provider
        .observed_catalog_download_options(
            listing,
            None,
            crate::ReleaseChannel::Stable,
            None,
            at("2026-11-10T01:00:00Z"),
        )
        .unwrap();
    assert_eq!(selected, Some(7));
    assert_eq!(
        candidates[0].asset_id,
        crate::CatalogDownloadAssetId::Github(11)
    );
    assert!(!coverage.release_history_complete);
    assert!(
        provider
            .observed_catalog_download_options(
                listing,
                None,
                crate::ReleaseChannel::Stable,
                None,
                at("2026-11-11T01:00:00Z")
            )
            .is_none(),
        "expiry cannot be advanced by signed delivery or cache reads"
    );
}

#[tokio::test]
async fn compact_listing_admission_preserves_decoded_identity_and_refuses_invalid_preferred_target()
{
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use flate2::{Compression, write::GzEncoder};
    use sha2::{Digest, Sha256};
    use std::io::Write as _;

    fn gzip(bytes: &[u8]) -> Vec<u8> {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(bytes).unwrap();
        encoder.finish().unwrap()
    }
    fn carrier(bytes: &[u8]) -> Value {
        json!({
            "carrier": listing_delivery::COMPACT_CARRIER,
            "decoded_bytes": bytes.len(),
            "decoded_sha256": hex::encode(Sha256::digest(bytes)),
            "gzip_base64": STANDARD.encode(gzip(bytes)),
        })
    }

    fn legacy_row(library: &Library) -> (String, String, i64) {
        let connection = library.connection().unwrap();
        connection
            .query_row(
                "SELECT document_json,provenance_json,(SELECT max(version) FROM schema_migrations)
             FROM listing_delivery WHERE singleton=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap()
    }

    let fixture = authority_provisioning::separated_fixture();
    let key = Key::new(fixture._directory.path());
    let (_temp, library) = library();
    let old = serde_json::to_vec(&feed(1)).unwrap();
    let root = publish(&fixture, &key, 1, &feed(1)).await;
    provision(&library, &root);
    let prior = refresh(&library, &fixture, &root).await.unwrap();
    assert_eq!(prior.transport_target_sha256, None);
    let first_legacy = legacy_row(&library);
    assert_eq!(first_legacy.0.as_bytes(), old.as_slice());
    let earlier_reader: policy::PolicyProvenance = serde_json::from_str(&first_legacy.1).unwrap();
    assert_eq!(Some(earlier_reader.target_sha256), prior.target_sha256);
    // A compact reader may already have created the original 8 MiB table.
    library
        .connection()
        .unwrap()
        .execute_batch(
            "CREATE TABLE compact_listing_delivery(
            singleton INTEGER PRIMARY KEY CHECK(singleton=1),
            document_json TEXT NOT NULL CHECK(length(CAST(document_json AS BLOB))<=8388608),
            provenance_json TEXT NOT NULL CHECK(length(CAST(provenance_json AS BLOB))<=16384));",
        )
        .unwrap();
    let mut next = serde_json::to_vec(&feed(2)).unwrap();
    next.resize(listing_delivery::MAX_BYTES + 1, b' ');
    assert!(listing_delivery::ListingDeliveryDocument::parse(&next).is_err());
    let next_digest = hex::encode(Sha256::digest(&next));

    let mut signed_carriers = vec![(carrier(&old), true, 1)];
    let current = carrier(&next);
    let mut expired_bound = current.clone();
    expired_bound["decoded_bytes"] = json!(listing_delivery::MAX_COMPACT_DECODED_BYTES + 1);
    let mut equivocation = current.clone();
    equivocation["decoded_sha256"] = json!("0".repeat(64));
    let mut unsupported = current.clone();
    unsupported["carrier"] = json!("unsupported");
    let mut trailing = current.clone();
    let mut concatenated = gzip(&next);
    concatenated.extend(gzip(b""));
    trailing["gzip_base64"] = json!(STANDARD.encode(concatenated));
    let mut too_short = current.clone();
    too_short["decoded_bytes"] = json!(next.len() - 1);
    for refusal in [
        expired_bound,
        equivocation,
        unsupported,
        trailing,
        too_short,
    ] {
        signed_carriers.push((refusal, false, 1));
    }
    signed_carriers.push((current, true, 2));
    let mut same_revision_replacement = next.clone();
    same_revision_replacement.push(b' ');
    signed_carriers.push((carrier(&same_revision_replacement), false, 2));

    let mut transport_digest = None;
    for (index, (compact, accepted, revision)) in signed_carriers.into_iter().enumerate() {
        let raw = serde_json::to_vec(&compact).unwrap();
        if accepted {
            transport_digest = Some(hex::encode(Sha256::digest(&raw)));
        }
        let root = fixture
            .publish_with_policy(
                &[
                    (listing_delivery::TARGET.into(), old.clone()),
                    (listing_delivery::COMPACT_TARGET.into(), raw),
                ],
                true,
                &DEFINITION_ROLE_PATHS,
                later(),
                Some((&key, index as u64 + 2)),
            )
            .await;
        let result = refresh(&library, &fixture, &root).await;
        assert_eq!(result.is_ok(), accepted, "carrier {index}");
        let stored = library.listing_delivery_status().unwrap();
        assert_eq!(stored.revision, Some(revision));
        assert_eq!(stored.transport_target_sha256, transport_digest);
        if revision == 1 {
            // Reload still uses exactly the original decoded content and digest.
            assert_eq!(stored.target_sha256, prior.target_sha256);
        } else {
            assert_eq!(stored.target_sha256.as_deref(), Some(next_digest.as_str()));
        }
    }

    assert_eq!(legacy_row(&library), first_legacy);
    let old_only = publish(&fixture, &key, 10, &feed(1)).await;
    assert!(refresh(&library, &fixture, &old_only).await.is_err());
    let current = library.listing_delivery_status().unwrap();
    assert_eq!(current.revision, Some(2));
    assert_eq!(current.transport_target_sha256, transport_digest);
    assert_eq!(legacy_row(&library), first_legacy);
    let catalog = library.load_catalog().unwrap().0;
    assert!(catalog.listing("new-unmanaged-port").is_ok());
    assert!(catalog.port("new-unmanaged-port").is_err());
}
