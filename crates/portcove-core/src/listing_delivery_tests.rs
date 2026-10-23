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
    listing_delivery::refresh_fixture(&service, &source, root, FilesystemTransport).await
}

fn provision(library: &Library, root: &[u8]) {
    let review = policy::provisioning::review_fixture(library, root).unwrap();
    policy::provisioning::apply_fixture(library, root, &review.expected_plan).unwrap();
}

#[tokio::test]
async fn authenticated_listings_add_correct_withdraw_without_managed_authority() {
    let fixture = RepositoryFixture::new();
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
    let tombstones = json!({"listing_delivery_schema":1,"revision":3,
        "withdrawn_ids":["new-unmanaged-port","shipwright"],"directory":{"format_version":1,"listings":[]}});
    let root3 = publish(&fixture, &key, 3, &tombstones).await;
    refresh(&library, &fixture, &root3).await.unwrap();
    let (catalog, _) = library.load_catalog().unwrap();
    assert!(catalog.listing("new-unmanaged-port").is_err());
    assert!(catalog.port("shipwright").is_ok());
    assert!(catalog.listing("shipwright").is_ok());
}

#[tokio::test]
async fn listing_replay_equivocation_and_failed_refresh_preserve_last_selection() {
    let fixture = RepositoryFixture::new();
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
