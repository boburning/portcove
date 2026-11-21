use super::*;
use policy::provisioning::{apply_fixture, review_fixture};
use policy::refresh::{DefinitionRefreshDisposition, refresh_fixture};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

fn request_leaf(url: &Url) -> Option<&str> {
    url.path_segments()?.next_back()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RefreshTarget {
    ListingDirectory,
    LaunchCompanion,
    CandidateIndex,
}

impl RefreshTarget {
    fn matches(self, url: &Url) -> bool {
        request_leaf(url).is_some_and(|leaf| match self {
            Self::ListingDirectory => leaf.ends_with("catalog.listings.json"),
            Self::LaunchCompanion => leaf.ends_with(".launch.json"),
            Self::CandidateIndex => leaf == "index.json",
        })
    }
}

#[test]
fn refresh_targets_match_url_leaves_independently_of_query_and_fragment() {
    for (relative, candidate, companion) in [
        ("index.json", true, false),
        ("targets/digest.index.json", false, false),
        ("targets/index.json?download=1#receipt", true, false),
        ("targets/index.json/child", false, false),
        ("targets/index.json/", false, false),
        ("targets/port.launch.json", false, true),
        (
            "targets/digest.port.launch.json?download=1#receipt",
            false,
            true,
        ),
        ("targets/port.launch.json/child", false, false),
        ("targets/port.launch.json.bak", false, false),
        (
            "targets/other.json?file=index.json#port.launch.json",
            false,
            false,
        ),
    ] {
        let url = Url::parse("https://definitions.invalid/")
            .unwrap()
            .join(relative)
            .unwrap();
        assert_eq!(
            RefreshTarget::CandidateIndex.matches(&url),
            candidate,
            "{url}"
        );
        assert_eq!(
            RefreshTarget::LaunchCompanion.matches(&url),
            companion,
            "{url}"
        );
    }
    let opaque = Url::parse("data:text/plain,index.json").unwrap();
    assert!(!RefreshTarget::CandidateIndex.matches(&opaque));
    assert!(!RefreshTarget::LaunchCompanion.matches(&opaque));
}

#[derive(Debug, Clone, Default)]
struct ObservedTransport {
    requests: Arc<Mutex<Vec<Url>>>,
    refuse_candidate: bool,
    suspended: Option<(RefreshTarget, Arc<tokio::sync::Notify>, Arc<AtomicUsize>)>,
}

struct PendingFetch(Arc<AtomicUsize>);

impl Drop for PendingFetch {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

#[async_trait::async_trait]
impl tough::Transport for ObservedTransport {
    async fn fetch(
        &self,
        url: Url,
    ) -> std::result::Result<tough::TransportStream, tough::TransportError> {
        self.requests.lock().unwrap().push(url.clone());
        if let Some((target, started, active)) = &self.suspended
            && target.matches(&url)
        {
            active.fetch_add(1, Ordering::SeqCst);
            let _pending = PendingFetch(active.clone());
            started.notify_one();
            std::future::pending::<()>().await;
        }
        let url = if self.refuse_candidate && RefreshTarget::CandidateIndex.matches(&url) {
            url.join("absent-candidate-fixture").unwrap()
        } else {
            url
        };
        tough::Transport::fetch(&FilesystemTransport, url).await
    }
}

fn source(fixture: &RepositoryFixture) -> DefinitionRepositorySource {
    DefinitionRepositorySource {
        metadata_base_url: fixture.metadata_url(),
        targets_base_url: fixture.targets_url(),
    }
}

fn provision(library: &Library, root: &[u8]) {
    let plan = review_fixture(library, root).unwrap();
    apply_fixture(library, root, &plan.expected_plan).unwrap();
}

fn ordinary_targets() -> Vec<(String, Vec<u8>)> {
    let mut document =
        serde_json::to_value(Catalog::embedded().unwrap().authoritative_document()).unwrap();
    let metadata = serde_json::to_value(metadata_catalog().authoritative_document()).unwrap();
    document["ports"]
        .as_array_mut()
        .unwrap()
        .push(metadata["ports"][0].clone());
    let catalog = Catalog::from_json(&document.to_string()).unwrap();
    repository_targets_for(&catalog, ID)
}

fn ordinary_availability(revision: u64) -> Value {
    availability_for(&ordinary_targets(), ID, revision)
}

fn ordinary_managed(revision: u64) -> Value {
    let mut document = managed_github(revision);
    let binding = ordinary_availability(revision);
    for field in [
        "definition_revision",
        "index_sha256",
        "definition_sha256",
        "template",
    ] {
        document["decision"][field] = binding["decision"][field].clone();
    }
    document
}

async fn publish_ordinary(
    fixture: &RepositoryFixture,
    key: &Key,
    version: u64,
    document: &Value,
) -> Vec<u8> {
    let mut targets = ordinary_targets();
    targets.push((
        format!("policy/official/{ID}.json"),
        serde_json::to_vec(document).unwrap(),
    ));
    fixture
        .publish_with_policy(
            &targets,
            true,
            &DEFINITION_ROLE_PATHS,
            later(),
            Some((key, version)),
        )
        .await
}

#[tokio::test]
async fn ordinary_unconfigured_and_unprovisioned_refresh_refuse_before_transport_or_activity() {
    let fixture = authority_provisioning::separated_fixture();
    let root = fixture.root(true).await;
    let (_directory, library) = library();
    let service = PortcoveService::new(library.clone()).unwrap();
    let transport = ObservedTransport::default();
    let error = refresh_fixture(
        &service,
        &source(&fixture),
        ID,
        &root,
        transport.clone(),
        |_| panic!("preflight emitted activity"),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::Conflict);
    assert!(transport.requests.lock().unwrap().is_empty());
    let error = refresh_fixture(
        &service,
        &source(&fixture),
        ID,
        b"null",
        transport.clone(),
        |_| panic!("unconfigured fixture emitted activity"),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::Unsupported);
    assert!(transport.requests.lock().unwrap().is_empty());
    let public_source = DefinitionRepositorySource::new(
        "https://definitions.invalid/metadata/",
        "https://definitions.invalid/targets/",
    )
    .unwrap();
    let error = service
        .refresh_definition(&public_source, ID, |_| {
            panic!("unprovisioned refresh emitted activity")
        })
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Conflict);
    assert!(library.activities(10).unwrap().is_empty());
    assert!(
        library
            .definition_selection_status()
            .unwrap()
            .selected
            .is_none()
    );
}

#[tokio::test]
async fn official_definition_refresh_preserves_known_identity_without_network_or_writes() {
    use policy::provisioning::official_catalog::official_definition_id;

    let (_directory, library) = library();
    let service = PortcoveService::new(library.clone()).unwrap();
    let port_id = &service.catalog().ports()[0].id;
    let listing_id = &service
        .catalog()
        .listings()
        .iter()
        .find(|listing| service.catalog().port(&listing.id).is_err())
        .expect("embedded catalog retains descriptive-only listings")
        .id;
    for id in [port_id, listing_id] {
        assert_eq!(official_definition_id(service.catalog(), id).unwrap(), id);
        // Desktop's generation-bound worker requires this public future to be Send.
        fn require_send<T: Send>(future: T) -> T {
            future
        }
        // Constructing the future runs nothing. Awaiting a known identity would
        // install the compiled anchor (official updates are on by default) and
        // contact the appointed production location, which tests never do; the
        // default-on installation is covered with a local fixture transport in
        // `automatic_official_refresh_defaults_on_stays_quiet_and_preserves_state`.
        drop(require_send(
            service
                .refresh_official_definition(id, |_| panic!("an unpolled check emitted activity")),
        ));
    }
    for id in [format!("official/{port_id}"), "unknown-new-port".to_owned()] {
        let error = service
            .refresh_official_definition(&id, |_| panic!("unknown identity emitted activity"))
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::NotFound);
    }
    // An unknown identity is refused before any trust is installed.
    assert!(!library.review_definition_authority().unwrap().installed);
    assert!(library.activities(10).unwrap().is_empty());
    assert!(
        library
            .definition_selection_status()
            .unwrap()
            .selected
            .is_none()
    );
}

#[tokio::test]
async fn ordinary_refresh_uses_one_authenticated_snapshot_and_exact_retry_preserves_selection() {
    let fixture = authority_provisioning::separated_fixture();
    let key = Key::new(fixture._directory.path());
    // A selectable catalog retains all existing entries. Generic metadata-only
    // fixtures deliberately omit them and cannot establish ordinary availability.
    let (catalog, id) = post_client_catalog();
    let mut targets = repository_targets_for(&catalog, &id);
    let document = availability_for(&targets, &id, 1);
    targets.push((
        format!("policy/official/{id}.json"),
        serde_json::to_vec(&document).unwrap(),
    ));
    let root = fixture
        .publish_with_policy(
            &targets,
            true,
            &DEFINITION_ROLE_PATHS,
            later(),
            Some((&key, 1)),
        )
        .await;
    let (_directory, library) = library();
    provision(&library, &root);
    let service = PortcoveService::new(library.clone()).unwrap();
    let transport = ObservedTransport::default();
    let first = refresh_fixture(
        &service,
        &source(&fixture),
        &id,
        &root,
        transport.clone(),
        |_| {},
    )
    .await
    .unwrap();
    assert!(matches!(
        first.disposition,
        DefinitionRefreshDisposition::Selected
    ));
    assert!(first.policy_changed);
    assert_eq!(first.refresh_schema, 1);
    assert_eq!(first.selection.selected.as_ref().unwrap().stable_id, id);
    assert_eq!(
        transport
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|url| request_leaf(url) == Some("timestamp.json"))
            .count(),
        1
    );
    let second = refresh_fixture(
        &service,
        &source(&fixture),
        &id,
        &root,
        FilesystemTransport,
        |_| {},
    )
    .await
    .unwrap();
    assert!(!second.policy_changed);
    assert_eq!(second.selection.revision, first.selection.revision);
    assert_eq!(second.selection.selected, first.selection.selected);
    assert!(service.catalog().definition_selection(&id).is_none());
    let fresh = PortcoveService::new(library.clone()).unwrap();
    assert!(fresh.catalog().definition_selection(&id).is_some());
    assert_eq!(
        policy::provisioning::official_catalog::official_definition_id(fresh.catalog(), &id)
            .unwrap(),
        first.selection.selected.as_ref().unwrap().stable_id,
    );

    // Change the separately signed baseline after this service was constructed.
    // An exact definition retry must revalidate that baseline in its transaction.
    use ed25519_dalek::Signer;
    let key = ed25519_dalek::SigningKey::from_bytes(&[19; 32]);
    library
        .trust_catalog_key(&hex::encode(key.verifying_key().as_bytes()))
        .unwrap();
    let mut baseline = crate::test_fixture::indexed_fixture_document(&Catalog::embedded().unwrap());
    // The legacy signature changes metadata. The reader supplies the
    // independent working-directory authority and tracked handoff compiled
    // into the client; a legacy catalog cannot deliver either.
    for port in &mut baseline.ports {
        port.windows_shipwright_persistence = false;
        port.windows_tracked_handoff = false;
    }
    baseline.ports[0].summary = "Changed independently signed baseline fixture".into();
    let now = Library::now();
    let payload = serde_json::to_string(&crate::SignedCatalogPayload {
        sequence: 1,
        issued_at: now - 60,
        expires_at: now + 3600,
        catalog: baseline,
    })
    .unwrap();
    let key_id = crate::signed_catalog::digest(key.verifying_key().as_bytes());
    let signature = key.sign(&crate::signed_catalog::signing_message(&key_id, &payload));
    let file = _directory.path().join("changed-baseline.json");
    fs::write(
        &file,
        serde_json::to_vec(&crate::SignedCatalogEnvelope {
            format_version: 1,
            key_id,
            payload,
            signature: hex::encode(signature.to_bytes()),
        })
        .unwrap(),
    )
    .unwrap();
    let baseline_source = crate::CatalogUpdateSource::File(file);
    let plan = service.plan_catalog_update(&baseline_source).await.unwrap();
    service
        .apply_catalog_update(&baseline_source, &plan.plan_sha256, |_| {})
        .await
        .unwrap();
    let error = refresh_fixture(
        &service,
        &source(&fixture),
        &id,
        &root,
        FilesystemTransport,
        |_| {},
    )
    .await
    .unwrap_err();
    assert_eq!(error.details["definition_refresh_phase"], "selection");
    assert_eq!(error.details["definition_policy_changed"], "false");
    assert_eq!(
        library.definition_selection_status().unwrap(),
        second.selection
    );
}

#[tokio::test]
async fn ordinary_refresh_cancels_suspended_companion_and_candidate_without_admission() {
    for target in [
        RefreshTarget::LaunchCompanion,
        RefreshTarget::CandidateIndex,
    ] {
        let fixture = authority_provisioning::separated_fixture();
        let key = Key::new(fixture._directory.path());
        let mut document = ordinary_managed(1);
        if target == RefreshTarget::LaunchCompanion {
            document["policy_schema"] = 3.into();
            document["decision"]["scoped_launch_checks"] = 1.into();
        }
        let root = publish_ordinary(&fixture, &key, 1, &document).await;
        if target == RefreshTarget::LaunchCompanion {
            let mut targets = ordinary_targets();
            targets.push((
                format!("policy/official/{ID}.json"),
                serde_json::to_vec(&document).unwrap(),
            ));
            let assessment = launch_assessments::assessment_document(
                &hex::encode(Sha256::digest(serde_json::to_vec(&document).unwrap())),
                1,
                vec![],
            );
            launch_assessments::publish_assessment_for_targets(
                &fixture,
                &key,
                &root,
                targets,
                2,
                &assessment,
            )
            .await
            .unwrap();
        }
        let (_directory, library) = library();
        provision(&library, &root);
        let service = PortcoveService::new(library.clone()).unwrap();
        let started = Arc::new(tokio::sync::Notify::new());
        let active = Arc::new(AtomicUsize::new(0));
        let events = Arc::new(Mutex::new(Vec::<crate::OperationEvent>::new()));
        let transport = ObservedTransport {
            suspended: Some((target, started.clone(), active.clone())),
            ..ObservedTransport::default()
        };
        let source = source(&fixture);
        let refresh = refresh_fixture(&service, &source, ID, &root, transport, |event| {
            events.lock().unwrap().push(event);
        });
        let cancel = async {
            tokio::time::timeout(std::time::Duration::from_secs(10), started.notified())
                .await
                .expect("refresh did not reach controlled fetch");
            let id = events.lock().unwrap()[0].operation_id.clone();
            service.request_cancellation(&id).unwrap();
        };
        let (result, ()) = tokio::join!(refresh, cancel);
        assert_eq!(result.unwrap_err().code, ErrorCode::Cancelled);
        assert_eq!(active.load(Ordering::SeqCst), 0);
        assert_eq!(count(&library, "definition_publisher_admission"), 0);
        assert_eq!(
            library.activities(1).unwrap()[0].status,
            crate::ActivityStatus::Cancelled
        );
        assert!(
            library
                .definition_selection_status()
                .unwrap()
                .selected
                .is_none()
        );
        let events = events.lock().unwrap();
        assert_eq!(events.len(), 2);
        assert!(matches!(
            events[0].event,
            crate::OperationEventKind::Started
        ));
        assert!(matches!(
            events[1].event,
            crate::OperationEventKind::Finished {
                result: crate::OperationResult::Cancelled
            }
        ));
    }
}

#[tokio::test]
async fn ordinary_refresh_persists_revocation_without_fetching_a_candidate() {
    let fixture = authority_provisioning::separated_fixture();
    let key = Key::new(fixture._directory.path());
    let mut document = ordinary_availability(1);
    let root = publish_ordinary(&fixture, &key, 1, &document).await;
    let (_directory, library) = library();
    provision(&library, &root);
    let service = PortcoveService::new(library.clone()).unwrap();
    let selected = refresh_fixture(
        &service,
        &source(&fixture),
        ID,
        &root,
        FilesystemTransport,
        |_| {},
    )
    .await
    .unwrap()
    .selection;
    document["policy_revision"] = 2.into();
    document["decision"] = serde_json::json!({"status":"revoked"});
    assert_eq!(publish_ordinary(&fixture, &key, 2, &document).await, root);
    let transport = ObservedTransport {
        refuse_candidate: true,
        ..ObservedTransport::default()
    };
    let result = refresh_fixture(
        &service,
        &source(&fixture),
        ID,
        &root,
        transport.clone(),
        |_| {},
    )
    .await
    .unwrap();
    assert!(matches!(
        result.disposition,
        DefinitionRefreshDisposition::Revoked
    ));
    assert!(result.policy_changed);
    assert_eq!(result.selection.selected, selected.selected);
    assert!(
        !transport
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|url| RefreshTarget::CandidateIndex.matches(url))
    );
    let status: String = library.connection().unwrap().query_row("SELECT status FROM definition_publisher_policy WHERE namespace='official' AND stable_id=?1", [ID], |row| row.get(0)).unwrap();
    assert_eq!(status, "revoked");
    publish_ordinary(&fixture, &key, 1, &ordinary_availability(1)).await;
    let replay = refresh_fixture(
        &service,
        &source(&fixture),
        ID,
        &root,
        FilesystemTransport,
        |_| {},
    )
    .await
    .unwrap_err();
    assert_eq!(replay.code, ErrorCode::Verification);
    assert_eq!(
        library.definition_selection_status().unwrap().selected,
        selected.selected
    );
    let status: String = library.connection().unwrap().query_row("SELECT status FROM definition_publisher_policy WHERE namespace='official' AND stable_id=?1", [ID], |row| row.get(0)).unwrap();
    assert_eq!(status, "revoked");
}

#[tokio::test]
async fn ordinary_refresh_retains_restrictive_admission_when_launch_companion_fails_then_recovers()
{
    for wrong_binding in [false, true] {
        let fixture = authority_provisioning::separated_fixture();
        let key = Key::new(fixture._directory.path());
        let mut document = ordinary_managed(1);
        let root = publish_ordinary(&fixture, &key, 1, &document).await;
        let (_directory, library) = library();
        provision(&library, &root);
        let service = PortcoveService::new(library.clone()).unwrap();
        let selected = refresh_fixture(
            &service,
            &source(&fixture),
            ID,
            &root,
            FilesystemTransport,
            |_| {},
        )
        .await
        .unwrap()
        .selection;
        document["policy_schema"] = 3.into();
        document["policy_revision"] = 2.into();
        document["decision"]["scoped_launch_checks"] = 1.into();
        if wrong_binding {
            let mut targets = ordinary_targets();
            targets.push((
                format!("policy/official/{ID}.json"),
                serde_json::to_vec(&document).unwrap(),
            ));
            launch_assessments::publish_assessment_for_targets(
                &fixture,
                &key,
                &root,
                targets,
                2,
                &launch_assessments::assessment_document(&"a".repeat(64), 1, vec![]),
            )
            .await
            .unwrap();
        } else {
            publish_ordinary(&fixture, &key, 2, &document).await;
        }
        let mut failed_events = Vec::new();
        let error = refresh_fixture(
            &service,
            &source(&fixture),
            ID,
            &root,
            FilesystemTransport,
            |event| failed_events.push(event),
        )
        .await
        .unwrap_err();
        assert_eq!(failed_events.len(), 2);
        assert!(matches!(
            failed_events[1].event,
            crate::OperationEventKind::Finished {
                result: crate::OperationResult::Failed
            }
        ));
        assert_eq!(
            library.activities(1).unwrap()[0].status,
            crate::ActivityStatus::Failed
        );
        assert_eq!(error.details["definition_policy_changed"], "true");
        assert_eq!(
            error.details["definition_refresh_phase"],
            "launch_assessment"
        );
        assert_eq!(
            library.definition_selection_status().unwrap().selected,
            selected.selected
        );
        let retained: String = library.connection().unwrap().query_row("SELECT policy_json FROM definition_publisher_admission WHERE namespace='official' AND stable_id=?1", [ID], |row| row.get(0)).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&retained).unwrap()["policy_revision"],
            2
        );
        let assessment = launch_assessments::assessment_document(
            &hex::encode(Sha256::digest(serde_json::to_vec(&document).unwrap())),
            1,
            vec![],
        );
        let mut targets = ordinary_targets();
        targets.push((
            format!("policy/official/{ID}.json"),
            serde_json::to_vec(&document).unwrap(),
        ));
        launch_assessments::publish_assessment_for_targets(
            &fixture,
            &key,
            &root,
            targets,
            3,
            &assessment,
        )
        .await
        .unwrap();
        let recovered = refresh_fixture(
            &service,
            &source(&fixture),
            ID,
            &root,
            FilesystemTransport,
            |_| {},
        )
        .await
        .unwrap();
        assert!(recovered.launch_assessment_changed);
        assert!(matches!(
            recovered.disposition,
            DefinitionRefreshDisposition::Selected
        ));
        assert_eq!(
            recovered
                .selection
                .selected
                .as_ref()
                .unwrap()
                .policy_revision,
            2
        );
        let retained_floor = || {
            library
                .connection()
                .unwrap()
                .query_row(
                    "SELECT replay_floor_json FROM definition_publisher_authority",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap()
        };
        let floor = retained_floor();
        let retried = refresh_fixture(
            &service,
            &source(&fixture),
            ID,
            &root,
            FilesystemTransport,
            |_| {},
        )
        .await
        .unwrap();
        assert!(!retried.policy_changed);
        assert!(!retried.launch_assessment_changed);
        assert_eq!(retried.selection, recovered.selection);
        assert_eq!(retained_floor(), floor);
    }
}

#[tokio::test]
async fn ordinary_refresh_cancellation_wins_before_network_and_admission() {
    let fixture = authority_provisioning::separated_fixture();
    let key = Key::new(fixture._directory.path());
    let root = publish_ordinary(&fixture, &key, 1, &ordinary_availability(1)).await;
    let (_directory, library) = library();
    provision(&library, &root);
    let service = PortcoveService::new(library.clone()).unwrap();
    let transport = ObservedTransport::default();
    let error = refresh_fixture(
        &service,
        &source(&fixture),
        ID,
        &root,
        transport.clone(),
        |event| {
            if matches!(event.event, crate::OperationEventKind::Started) {
                service.request_cancellation(&event.operation_id).unwrap();
            }
        },
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::Cancelled);
    assert!(transport.requests.lock().unwrap().is_empty());
    assert_eq!(count(&library, "definition_publisher_admission"), 0);
    assert!(
        library
            .definition_selection_status()
            .unwrap()
            .selected
            .is_none()
    );
}

#[tokio::test]
async fn ordinary_refresh_refuses_a_transition_that_removes_unrelated_catalog_entries() {
    let fixture = authority_provisioning::separated_fixture();
    let key = Key::new(fixture._directory.path());
    let root = publish_ordinary(&fixture, &key, 1, &ordinary_availability(1)).await;
    let (_directory, library) = library();
    provision(&library, &root);
    let service = PortcoveService::new(library.clone()).unwrap();
    let before = refresh_fixture(
        &service,
        &source(&fixture),
        ID,
        &root,
        FilesystemTransport,
        |_| {},
    )
    .await
    .unwrap()
    .selection;
    // Authenticate a valid standalone definition which omits the existing
    // catalog. It must not become an ordinary selected/available transition.
    publish(&fixture, &key, 2, &availability(2)).await;
    let error = refresh_fixture(
        &service,
        &source(&fixture),
        ID,
        &root,
        FilesystemTransport,
        |_| {},
    )
    .await
    .unwrap_err();
    assert_eq!(error.details["definition_refresh_phase"], "selection");
    assert_eq!(error.details["definition_policy_changed"], "true");
    assert_eq!(library.definition_selection_status().unwrap(), before);
    let retained: String = library.connection().unwrap().query_row(
        "SELECT policy_json FROM definition_publisher_admission WHERE namespace='official' AND stable_id=?1",
        [ID], |row| row.get(0),
    ).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&retained).unwrap()["policy_revision"],
        2
    );
}

#[tokio::test]
async fn scheduled_refresh_shares_metadata_and_preserves_each_known_definition_scope() {
    use crate::OfficialCatalogAutomaticOutcome as Outcome;
    use policy::provisioning::official_catalog::{
        automatic_refresh_fixture, serialize_automatic_refresh_fixtures,
    };
    let _fixtures = serialize_automatic_refresh_fixtures().await;

    const SOURCE: &[u8] = br#"{"metadata_base_url":"https://catalog.invalid/metadata/","targets_base_url":"https://catalog.invalid/targets/"}"#;
    let fixture = authority_provisioning::separated_fixture();
    let key = Key::new(fixture._directory.path());
    let root = authority_provisioning::single_owner_root(&fixture).await;
    let (_directory, library) = library();
    let host = tempfile::tempdir().unwrap();
    let preferences =
        crate::HostPreferenceStore::new(host.path().join("preferences.json")).unwrap();
    let service = PortcoveService::new(library.clone()).unwrap();
    let repository = source(&fixture);
    let catalog = Catalog::embedded().unwrap();
    let ids = [
        catalog.ports()[0].id.as_str(),
        catalog.ports()[1].id.as_str(),
    ];
    let entries = ids.map(|id| repository_targets_for(&catalog, id));
    let mut definitions = Vec::new();
    let mut contents = std::collections::BTreeMap::new();
    let mut targets = std::collections::BTreeMap::new();
    for entry in &entries {
        let index: Value = serde_json::from_slice(&entry[0].1).unwrap();
        definitions.extend(index["definitions"].as_array().unwrap().iter().cloned());
        for record in index["contents"].as_array().unwrap() {
            contents.insert(
                record["target"].as_str().unwrap().to_owned(),
                record.clone(),
            );
        }
        targets.extend(entry.iter().skip(1).cloned());
    }
    let index = serde_json::to_vec(&serde_json::json!({
        "index_schema": 1,
        "definitions": definitions,
        "contents": contents.into_values().collect::<Vec<_>>(),
    }))
    .unwrap();
    let index_sha256 = hex::encode(Sha256::digest(&index));
    targets.insert(INDEX_TARGET.to_owned(), index);
    for (id, entry) in ids.iter().zip(&entries) {
        let mut document = availability_for(entry, id, 1);
        document["decision"]["index_sha256"] = index_sha256.clone().into();
        targets.insert(
            format!("policy/official/{id}.json"),
            serde_json::to_vec(&document).unwrap(),
        );
    }
    // An authenticated but unknown policy target cannot make a new ID known.
    targets.insert(
        "policy/official/unlisted-scheduled-fixture.json".into(),
        b"unknown scope must not be read".to_vec(),
    );
    let original_expiration = later();
    fixture
        .publish_with_policy(
            &targets.clone().into_iter().collect::<Vec<_>>(),
            true,
            &DEFINITION_ROLE_PATHS,
            original_expiration,
            Some((&key, 1)),
        )
        .await;

    let transport = ObservedTransport::default();
    preferences
        .set_official_catalog_automatic_updates(false)
        .unwrap();
    let off = automatic_refresh_fixture(
        &service,
        &preferences,
        &root,
        SOURCE,
        &repository,
        transport.clone(),
    )
    .await
    .unwrap();
    assert_eq!(off.outcome, Outcome::TurnedOff);
    assert!(transport.requests.lock().unwrap().is_empty());
    assert!(library.activities(10).unwrap().is_empty());

    preferences
        .set_official_catalog_automatic_updates(true)
        .unwrap();
    let first = automatic_refresh_fixture(
        &service,
        &preferences,
        &root,
        SOURCE,
        &repository,
        transport.clone(),
    )
    .await
    .unwrap();
    // No descriptive target in this fixture. Known definitions can still be admitted.
    assert_eq!(first.outcome, Outcome::Refreshed);
    let selections = ids.map(|id| {
        library
            .definition_selection_status_for("official", id)
            .unwrap()
    });
    for (id, selection) in ids.iter().zip(&selections) {
        assert_eq!(selection.selected.as_ref().unwrap().stable_id, *id);
        let (effective, _) = library.load_catalog().unwrap();
        assert!(effective.definition_selection(id).is_some());
    }
    let requests = transport.requests.lock().unwrap();
    assert_eq!(
        requests
            .iter()
            .filter(|url| request_leaf(url) == Some("timestamp.json"))
            .count(),
        1
    );
    assert_eq!(
        requests
            .iter()
            .filter(|url| request_leaf(url)
                .is_some_and(|leaf| leaf.ends_with(".index.json") || leaf == "index.json"))
            .count(),
        1
    );
    assert!(
        !requests
            .iter()
            .any(|url| url.path().ends_with("unlisted-scheduled-fixture.json"))
    );
    drop(requests);

    let activities = library.activities(10).unwrap().len();
    let replay = automatic_refresh_fixture(
        &service,
        &preferences,
        &root,
        SOURCE,
        &repository,
        ObservedTransport::default(),
    )
    .await
    .unwrap();
    assert_eq!(replay.outcome, Outcome::Refreshed);
    assert_eq!(library.activities(10).unwrap().len(), activities);
    assert_eq!(
        ids.map(|id| library
            .definition_selection_status_for("official", id)
            .unwrap()),
        selections
    );

    let original_targets = targets.clone().into_iter().collect::<Vec<_>>();
    targets.insert(
        policy::listing_delivery::TARGET.into(),
        serde_json::to_vec(&serde_json::json!({
            "listing_delivery_schema": 1,
            "revision": 1,
            "withdrawn_ids": [],
            "directory": {"format_version": 1, "listings": []},
        }))
        .unwrap(),
    );
    for (index, id) in ids.into_iter().enumerate() {
        let policy_path = format!("policy/official/{id}.json");
        let mut document: Value = serde_json::from_slice(&targets[&policy_path]).unwrap();
        document["policy_revision"] = 2.into();
        if index == 0 {
            document["decision"] = serde_json::json!({ "status": "revoked" });
        } else {
            document["policy_schema"] = 99.into();
        }
        targets.insert(policy_path, serde_json::to_vec(&document).unwrap());
    }
    fixture
        .publish_with_policy(
            &targets.into_iter().collect::<Vec<_>>(),
            true,
            &DEFINITION_ROLE_PATHS,
            later(),
            Some((&key, 2)),
        )
        .await;
    let started = Arc::new(tokio::sync::Notify::new());
    let pending = Arc::new(AtomicUsize::new(0));
    let transport = ObservedTransport {
        suspended: Some((
            RefreshTarget::ListingDirectory,
            started.clone(),
            pending.clone(),
        )),
        ..Default::default()
    };
    let mut check = Box::pin(automatic_refresh_fixture(
        &service,
        &preferences,
        &root,
        SOURCE,
        &repository,
        transport,
    ));
    tokio::select! {
        result = &mut check => panic!("scheduled check skipped stalled listing: {result:?}"),
        () = started.notified() => {}
    }
    assert_eq!(pending.load(Ordering::SeqCst), 1);
    // The valid scoped revocation is still processed after the listing deadline.
    tokio::time::pause();
    tokio::time::advance(std::time::Duration::from_secs(26)).await;
    let partial = check.await.unwrap();
    tokio::time::resume();
    assert_eq!(pending.load(Ordering::SeqCst), 0);
    assert_eq!(partial.outcome, Outcome::Refreshed);
    let (effective, _) = library.load_catalog().unwrap();
    assert!(effective.definition_selection(ids[0]).is_none());
    assert!(effective.definition_selection(ids[1]).is_some());
    assert_eq!(
        library
            .definition_selection_status_for("official", ids[1])
            .unwrap()
            .selected,
        selections[1].selected,
    );

    // The second subject still holds the exact old bytes. The accepted
    // withdrawal for its neighbor advanced shared authority, so their old
    // snapshot cannot qualify as a successful no-op.
    fixture
        .publish_with_policy(
            &original_targets,
            true,
            &DEFINITION_ROLE_PATHS,
            original_expiration,
            Some((&key, 1)),
        )
        .await;
    let stale = automatic_refresh_fixture(
        &service,
        &preferences,
        &root,
        SOURCE,
        &repository,
        ObservedTransport::default(),
    )
    .await
    .unwrap();
    assert_eq!(stale.outcome, Outcome::Unavailable);
    let (effective, _) = library.load_catalog().unwrap();
    assert!(effective.definition_selection(ids[0]).is_none());
    assert!(effective.definition_selection(ids[1]).is_some());
}
