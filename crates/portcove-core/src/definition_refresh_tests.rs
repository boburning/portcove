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
    LaunchCompanion,
    CandidateIndex,
}

impl RefreshTarget {
    fn matches(self, url: &Url) -> bool {
        request_leaf(url).is_some_and(|leaf| match self {
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
    let public_source = DefinitionRepositorySource::new(
        "https://definitions.invalid/metadata/",
        "https://definitions.invalid/targets/",
    )
    .unwrap();
    let error = service
        .refresh_definition(&public_source, ID, |_| {
            panic!("unconfigured refresh emitted activity")
        })
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Unsupported);
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

    // Change the separately signed baseline after this service was constructed.
    // An exact definition retry must revalidate that baseline in its transaction.
    use ed25519_dalek::Signer;
    let key = ed25519_dalek::SigningKey::from_bytes(&[19; 32]);
    library
        .trust_catalog_key(&hex::encode(key.verifying_key().as_bytes()))
        .unwrap();
    let mut baseline = Catalog::embedded()
        .unwrap()
        .authoritative_document()
        .clone();
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
        assert_eq!(recovered.selection.selected.unwrap().policy_revision, 2);
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
