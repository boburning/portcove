use super::*;
use policy::provisioning::{apply_fixture, review_fixture};
use policy::refresh::{DefinitionRefreshDisposition, refresh_fixture};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Default)]
struct ObservedTransport {
    requests: Arc<Mutex<Vec<String>>>,
    refuse_candidate: bool,
    suspended: Option<(String, Arc<tokio::sync::Notify>, Arc<AtomicUsize>)>,
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
        self.requests.lock().unwrap().push(url.to_string());
        if let Some((needle, started, active)) = &self.suspended
            && url.path().contains(needle)
        {
            active.fetch_add(1, Ordering::SeqCst);
            let _pending = PendingFetch(active.clone());
            started.notify_one();
            std::future::pending::<()>().await;
        }
        let url = if self.refuse_candidate && url.path().contains("/definitions/") {
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
    let root = publish(&fixture, &key, 1, &availability(1)).await;
    let (_directory, library) = library();
    provision(&library, &root);
    let service = PortcoveService::new(library.clone()).unwrap();
    let transport = ObservedTransport::default();
    let first = refresh_fixture(
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
        first.disposition,
        DefinitionRefreshDisposition::Selected
    ));
    assert!(first.policy_changed);
    assert_eq!(first.refresh_schema, 1);
    assert_eq!(first.selection.selected.as_ref().unwrap().stable_id, ID);
    assert_eq!(
        transport
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|url| url.ends_with("/timestamp.json"))
            .count(),
        1
    );
    let second = refresh_fixture(
        &service,
        &source(&fixture),
        ID,
        &root,
        FilesystemTransport,
        |_| {},
    )
    .await
    .unwrap();
    assert!(!second.policy_changed);
    assert_eq!(second.selection.revision, first.selection.revision);
    assert_eq!(second.selection.selected, first.selection.selected);
    assert!(service.catalog().definition_selection(ID).is_none());
    let fresh = PortcoveService::new(library).unwrap();
    assert!(fresh.catalog().definition_selection(ID).is_some());
}

#[tokio::test]
async fn ordinary_refresh_cancels_suspended_companion_and_candidate_without_admission() {
    for needle in [".launch.json", "/definitions/"] {
        let fixture = authority_provisioning::separated_fixture();
        let key = Key::new(fixture._directory.path());
        let mut document = managed_github(1);
        if needle == ".launch.json" {
            document["policy_schema"] = 3.into();
            document["decision"]["scoped_launch_checks"] = 1.into();
        }
        let root = publish(&fixture, &key, 1, &document).await;
        let (_directory, library) = library();
        provision(&library, &root);
        let service = PortcoveService::new(library.clone()).unwrap();
        let started = Arc::new(tokio::sync::Notify::new());
        let active = Arc::new(AtomicUsize::new(0));
        let events = Arc::new(Mutex::new(Vec::<crate::OperationEvent>::new()));
        let transport = ObservedTransport {
            suspended: Some((needle.into(), started.clone(), active.clone())),
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
            crate::OperationEventKind::Finished { .. }
        ));
    }
}

#[tokio::test]
async fn ordinary_refresh_persists_revocation_without_fetching_a_candidate() {
    let fixture = authority_provisioning::separated_fixture();
    let key = Key::new(fixture._directory.path());
    let mut document = availability(1);
    let root = publish(&fixture, &key, 1, &document).await;
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
    assert_eq!(publish(&fixture, &key, 2, &document).await, root);
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
            .any(|url| url.contains("/definitions/"))
    );
    let status: String = library.connection().unwrap().query_row("SELECT status FROM definition_publisher_policy WHERE namespace='official' AND stable_id=?1", [ID], |row| row.get(0)).unwrap();
    assert_eq!(status, "revoked");
    publish(&fixture, &key, 1, &availability(1)).await;
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
        let mut document = managed_github(1);
        let root = publish(&fixture, &key, 1, &document).await;
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
            let mut targets = metadata_targets();
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
            publish(&fixture, &key, 2, &document).await;
        }
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
        let mut targets = metadata_targets();
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
    let root = publish(&fixture, &key, 1, &availability(1)).await;
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
