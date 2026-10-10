use super::super::publisher_policy as policy;
use super::*;
use crate::{PortcoveError, ReleaseChannel};

const ID: &str = "tuf-metadata-fixture";

#[path = "definition_launch_assessment_tests.rs"]
mod launch_assessments;

#[cfg(feature = "qualification-fixtures")]
#[path = "definition_compiled_client_tests.rs"]
mod compiled_clients;

#[cfg(feature = "qualification-fixtures")]
#[path = "definition_forbidden_memories_qualification_tests.rs"]
mod forbidden_memories_qualification;

fn availability(revision: u64) -> Value {
    let targets = metadata_targets();
    availability_for(&targets, ID, revision)
}

fn managed_github(revision: u64) -> Value {
    let mut document = availability(revision);
    document["policy_schema"] = serde_json::json!(2);
    document["grant_id"] = serde_json::json!("managed-github-v1-fixture");
    document["decision"]["status"] = serde_json::json!("managed_github");
    document["decision"]["repository_id"] = serde_json::json!(1296269);
    document["decision"]["artifact_hosts"] =
        serde_json::json!(["github.com", "release-assets.githubusercontent.com"]);
    document["decision"]["max_redirects"] = serde_json::json!(5);
    document["decision"]["operations"] =
        serde_json::json!(["install", "update", "prepare", "launch"]);
    document
}

#[tokio::test]
async fn managed_github_scope_admits_only_its_coupled_lifecycle() {
    let fixture = RepositoryFixture::new();
    let key = Key::new(fixture._directory.path());
    let mut targets = metadata_targets();
    targets.push((
        format!("policy/official/{ID}.json"),
        serde_json::to_vec(&managed_github(1)).unwrap(),
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
    let candidate = acquire(&fixture, &root).await.unwrap();
    let admission = acquire_policy(&fixture, &root, ID).await.unwrap();
    let (_directory, library) = library();
    policy::install_authority_for_test(&library, &root).unwrap();
    library
        .apply_definition_publisher_policy(&admission, Some(&candidate))
        .unwrap();
    let eligible = library
        .assess_definition_candidate(&candidate, "official", ID)
        .unwrap()
        .into_eligible()
        .unwrap();
    let identity = library
        .select_definition_candidate(eligible)
        .unwrap()
        .selected
        .unwrap();
    for operation in [
        DefinitionOperation::Install,
        DefinitionOperation::Update,
        DefinitionOperation::Prepare,
        DefinitionOperation::Launch,
        DefinitionOperation::RegisterExternal,
    ] {
        let eligibility = library
            .assess_definition_operation(
                &identity,
                DefinitionOperationContext::observed(
                    operation,
                    operation == DefinitionOperation::Launch,
                    true,
                ),
            )
            .unwrap();
        assert_eq!(
            eligibility.outcome == DefinitionEligibilityOutcome::Eligible,
            operation != DefinitionOperation::RegisterExternal,
            "{operation:?}",
        );
    }
}

async fn assert_signed_managed_policy_refused(document: Value) {
    let fixture = RepositoryFixture::new();
    let key = Key::new(fixture._directory.path());
    let root = publish(&fixture, &key, 1, &document).await;
    assert!(acquire_policy(&fixture, &root, ID).await.is_err());
}

#[tokio::test]
async fn managed_signed_policy_refuses_unknown_safety_fields() {
    let mut document = managed_github(1);
    document["decision"]["allow_credentials"] = true.into();
    assert_signed_managed_policy_refused(document).await;
}

#[tokio::test]
async fn managed_signed_policy_refuses_partial_operations() {
    let mut document = managed_github(1);
    document["decision"]["operations"] = serde_json::json!(["install", "launch"]);
    assert_signed_managed_policy_refused(document).await;
}

#[tokio::test]
async fn managed_signed_policy_refuses_wider_operations() {
    let mut document = managed_github(1);
    document["decision"]["operations"] = serde_json::json!([
        "install",
        "update",
        "prepare",
        "launch",
        "register_external"
    ]);
    assert_signed_managed_policy_refused(document).await;
}

#[tokio::test]
async fn managed_signed_policy_refuses_schema_scope_confusion() {
    let mut document = managed_github(1);
    document["policy_schema"] = 1.into();
    assert_signed_managed_policy_refused(document).await;
}

fn availability_for(targets: &[(String, Vec<u8>)], id: &str, revision: u64) -> Value {
    let index: Value = serde_json::from_slice(&targets[0].1).unwrap();
    let target = index["definitions"][0]["target"].as_str().unwrap();
    let bytes = &targets.iter().find(|(name, _)| name == target).unwrap().1;
    let entry: Value = serde_json::from_slice(bytes).unwrap();
    serde_json::json!({
        "policy_schema": 1,
        "namespace": "official",
        "stable_id": id,
        "policy_revision": revision,
        "grant_id": "protected-fixture-availability",
        "decision": {
            "status": "availability",
            "definition_revision": entry["revision"],
            "index_sha256": hex::encode(Sha256::digest(&targets[0].1)),
            "definition_sha256": hex::encode(Sha256::digest(bytes)),
            "template": entry["port"]["adapter"],
        },
    })
}

#[tokio::test]
async fn availability_only_definition_cannot_be_adopted_into_retained_lifecycle_authority() {
    let fixture = RepositoryFixture::new();
    let key = Key::new(fixture._directory.path());
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
    let candidate = acquire(&fixture, &root).await.unwrap();
    let admission = acquire_policy(&fixture, &root, &id).await.unwrap();
    let (directory, library) = library();
    policy::install_authority_for_test(&library, &root).unwrap();
    library
        .apply_definition_publisher_policy(&admission, Some(&candidate))
        .unwrap();
    let eligible = library
        .assess_definition_candidate(&candidate, "official", &id)
        .unwrap()
        .into_eligible()
        .unwrap();
    library.select_definition_candidate(eligible).unwrap();
    let service = PortcoveService::new(library.clone()).unwrap();
    assert_eq!(
        service
            .catalog()
            .definition_selection(&id)
            .unwrap()
            .stable_id,
        id
    );
    let source = directory.path().join("existing-install");
    fs::create_dir(&source).unwrap();
    let platform = crate::Platform::current().unwrap();
    let executable = source.join(&catalog.port(&id).unwrap().executable_hints[&platform][0]);
    if let Some(parent) = executable.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(&executable, b"synthetic local application").unwrap();
    crate::permissions::normalize_archive_entry(&executable, false, true).unwrap();
    let preview = service.preview_adoption(&source, Some(&id)).unwrap();
    let authorization = service
        .authorize_adoption(&source, Some(&id), &preview.plan_sha256)
        .unwrap();
    let error = service
        .adopt(&source, Some(&id), &authorization.token)
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Unsupported);
    assert_eq!(count(&library, "installs"), 0);
    assert!(service.status(&id).unwrap().active.is_none());
    assert_eq!(
        fs::read(executable).unwrap(),
        b"synthetic local application"
    );
}

struct RevokePreparedAdoption {
    library: Library,
    revocation: crate::AuthenticatedDefinitionPublisherPolicy,
    interrupt: bool,
}

impl crate::operation::LifecycleFaultInjector for RevokePreparedAdoption {
    fn check(&self, point: crate::operation::LifecycleFaultPoint) -> crate::Result<()> {
        if point == crate::operation::LifecycleFaultPoint::AdoptionPrepared {
            self.library
                .apply_definition_publisher_policy(&self.revocation, None)?;
            if self.interrupt {
                return Err(crate::PortcoveError::state(
                    "fixture interruption after protected revocation",
                ));
            }
        }
        Ok(())
    }
}

#[tokio::test]
async fn prepared_adoption_revocation_survives_rejection_and_interrupted_restart() {
    for interrupt in [false, true] {
        let fixture = RepositoryFixture::new();
        let key = Key::new(fixture._directory.path());
        let (catalog, id) = post_client_catalog();
        let mut targets = repository_targets_for(&catalog, &id);
        let mut document = availability_for(&targets, &id, 2);
        document["decision"] = serde_json::json!({"status":"revoked"});
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
        let candidate = acquire(&fixture, &root).await.unwrap();
        let revocation = acquire_policy(&fixture, &root, &id).await.unwrap();
        let (directory, library) = library();
        policy::install_authority_for_test(&library, &root).unwrap();
        // This represents a previously independently qualified lifecycle grant;
        // the new availability-only admission cannot authorize the initial copy.
        library
            .install_definition_policy_for_test(
                &candidate,
                "official",
                &id,
                1,
                "historical-independent-fixture",
                DefinitionPublisherStatus::Scoped,
            )
            .unwrap();
        let eligible = library
            .assess_definition_candidate(&candidate, "official", &id)
            .unwrap()
            .into_eligible()
            .unwrap();
        library.select_definition_candidate(eligible).unwrap();
        let service = PortcoveService::with_faults(
            library.clone(),
            std::sync::Arc::new(RevokePreparedAdoption {
                library: library.clone(),
                revocation,
                interrupt,
            }),
        )
        .unwrap();
        let source = directory.path().join("existing-install");
        fs::create_dir(&source).unwrap();
        let platform = crate::Platform::current().unwrap();
        let relative = &catalog.port(&id).unwrap().executable_hints[&platform][0];
        let executable = source.join(relative);
        fs::create_dir_all(executable.parent().unwrap()).unwrap();
        fs::write(&executable, b"retained source application").unwrap();
        crate::permissions::normalize_archive_entry(&executable, false, true).unwrap();
        let preview = service.preview_adoption(&source, Some(&id)).unwrap();
        let authorization = service
            .authorize_adoption(&source, Some(&id), &preview.plan_sha256)
            .unwrap();
        assert!(
            service
                .adopt(&source, Some(&id), &authorization.token)
                .is_err()
        );
        assert_eq!(count(&library, "installs"), 0);
        let store = crate::operation::OperationStore::new(library.clone());
        let operations = store.all().unwrap();
        assert_eq!(operations.len(), 1);
        let before = &operations[0];
        assert_eq!(before.phase, crate::operation::LifecyclePhase::Prepared);
        let staging = before.paths.staging.as_ref().unwrap();
        let copied_executable = staging.join("payload").join(relative);
        let staged_bytes = fs::read(&copied_executable).unwrap();
        assert!(!before.install.as_ref().unwrap().path.exists());
        drop(service);
        let recovered = PortcoveService::new(library.clone()).unwrap();
        recovered.recover_pending_operations().unwrap();
        assert_eq!(count(&library, "installs"), 0);
        let after = store.get(&before.id).unwrap().unwrap();
        assert_eq!(after.phase, crate::operation::LifecyclePhase::Prepared);
        assert!(!after.install.as_ref().unwrap().path.exists());
        assert_eq!(fs::read(copied_executable).unwrap(), staged_bytes);
        assert_eq!(
            fs::read(executable).unwrap(),
            b"retained source application"
        );
        assert!(after.last_error.unwrap().contains("on hold"));
    }
}

async fn publish(
    fixture: &RepositoryFixture,
    key: &Key,
    version: u64,
    document: &Value,
) -> Vec<u8> {
    let mut targets = metadata_targets();
    targets.push((
        format!(
            "policy/official/{}.json",
            document["stable_id"].as_str().unwrap()
        ),
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

async fn acquire_policy(
    fixture: &RepositoryFixture,
    root: &[u8],
    id: &str,
) -> crate::Result<crate::AuthenticatedDefinitionPublisherPolicy> {
    policy::acquire_with_transport(
        root,
        fixture.metadata_url(),
        fixture.targets_url(),
        FilesystemTransport,
        "official",
        id,
    )
    .await
}

fn library() -> (TempDir, Library) {
    let directory = tempfile::tempdir().unwrap();
    let library = Library::open(directory.path()).unwrap();
    (directory, library)
}

fn count(library: &Library, table: &str) -> i64 {
    library
        .connection()
        .unwrap()
        .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .unwrap()
}

#[tokio::test]
async fn authenticated_policy_cannot_install_its_own_authority() {
    let fixture = RepositoryFixture::new();
    let key = Key::new(fixture._directory.path());
    let root = publish(&fixture, &key, 1, &availability(1)).await;
    let candidate = acquire(&fixture, &root).await.unwrap();
    let policy = acquire_policy(&fixture, &root, ID).await.unwrap();
    let (_directory, library) = library();
    assert!(
        library
            .apply_definition_publisher_policy(&policy, Some(&candidate))
            .is_err()
    );
    assert_eq!(count(&library, "definition_publisher_authority"), 0);
    assert_eq!(count(&library, "definition_publisher_admission"), 0);
    assert_eq!(count(&library, "definition_publisher_policy"), 0);
    assert_eq!(
        library
            .assess_definition_candidate(&candidate, "official", ID)
            .unwrap()
            .eligibility()
            .reason,
        DefinitionEligibilityReason::PublisherScopeRequired
    );
}

#[tokio::test]
async fn protected_policy_enables_exact_availability_but_no_acquisition_operation() {
    let fixture = RepositoryFixture::new();
    let key = Key::new(fixture._directory.path());
    let root = publish(&fixture, &key, 1, &availability(1)).await;
    let candidate = acquire(&fixture, &root).await.unwrap();
    let policy = acquire_policy(&fixture, &root, ID).await.unwrap();
    let (_directory, library) = library();
    policy::install_authority_for_test(&library, &root).unwrap();
    assert!(
        library
            .apply_definition_publisher_policy(&policy, Some(&candidate))
            .unwrap()
    );
    assert!(
        !library
            .apply_definition_publisher_policy(&policy, Some(&candidate))
            .unwrap()
    );
    let eligible = library
        .assess_definition_candidate(&candidate, "official", ID)
        .unwrap()
        .into_eligible()
        .unwrap();
    let identity = library
        .select_definition_candidate(eligible)
        .unwrap()
        .selected
        .unwrap();
    let policy_expiration =
        policy::availability_expiration(&library.connection().unwrap(), "official", ID)
            .unwrap()
            .unwrap();
    let loaded = crate::definition_candidate::selection::load_selected_definition_catalog(
        &library.connection().unwrap(),
        &metadata_catalog(),
        now_unix(),
    )
    .unwrap()
    .unwrap();
    assert_eq!(loaded.1, policy_expiration);
    assert!(
        crate::definition_candidate::selection::load_selected_definition_catalog(
            &library.connection().unwrap(),
            &metadata_catalog(),
            policy_expiration
        )
        .is_err()
    );
    for operation in [
        DefinitionOperation::Install,
        DefinitionOperation::Update,
        DefinitionOperation::Prepare,
        DefinitionOperation::RegisterExternal,
        DefinitionOperation::Launch,
    ] {
        for retained in [false, true] {
            let result = library
                .assess_definition_operation(
                    &identity,
                    DefinitionOperationContext::observed(operation, retained, true),
                )
                .unwrap();
            assert_eq!(
                result.reason,
                DefinitionEligibilityReason::PublisherScopeRequired,
                "{operation:?}"
            );
            assert_ne!(result.outcome, DefinitionEligibilityOutcome::Eligible);
        }
    }
}

#[tokio::test]
async fn policy_role_cannot_reuse_definition_signing_key() {
    let fixture = RepositoryFixture::new();
    let root = publish(&fixture, &fixture.definitions, 1, &availability(1)).await;
    assert!(acquire_policy(&fixture, &root, ID).await.is_err());
}

#[tokio::test]
async fn descriptor_aliases_do_not_create_independent_signing_material() {
    let directory = tempfile::tempdir().unwrap();
    let key = Key::new(directory.path());
    let original = key.source().as_sign().await.unwrap().tuf_key();
    let mut descriptor = serde_json::to_value(&original).unwrap();
    descriptor["ignored-role-label"] = "independent-looking".into();
    descriptor["keyval"]["ignored-key-label"] = "policy".into();
    let alias: tough::schema::key::Key = serde_json::from_value(descriptor).unwrap();
    assert_ne!(original.key_id().unwrap(), alias.key_id().unwrap());
    assert_eq!(
        policy::signing_material(&original),
        policy::signing_material(&alias)
    );
    let different = Key::new(directory.path())
        .source()
        .as_sign()
        .await
        .unwrap()
        .tuf_key();
    assert_ne!(
        policy::signing_material(&original),
        policy::signing_material(&different)
    );
}

#[tokio::test]
async fn admitted_authority_cannot_return_to_an_empty_replay_floor() {
    let fixture = RepositoryFixture::new();
    let key = Key::new(fixture._directory.path());
    let root = publish(&fixture, &key, 1, &availability(1)).await;
    let candidate = acquire(&fixture, &root).await.unwrap();
    let admission = acquire_policy(&fixture, &root, ID).await.unwrap();
    let (_directory, library) = library();
    policy::install_authority_for_test(&library, &root).unwrap();
    library
        .apply_definition_publisher_policy(&admission, Some(&candidate))
        .unwrap();
    let eligible = library
        .assess_definition_candidate(&candidate, "official", ID)
        .unwrap()
        .into_eligible()
        .unwrap();
    let identity = library
        .select_definition_candidate(eligible)
        .unwrap()
        .selected
        .unwrap();
    library
        .connection()
        .unwrap()
        .execute(
            "UPDATE definition_publisher_authority SET replay_floor_json=NULL",
            [],
        )
        .unwrap();
    assert!(
        library
            .assess_definition_candidate(&candidate, "official", ID)
            .is_err()
    );
    assert!(
        crate::definition_candidate::selection::load_selected_definition_catalog(
            &library.connection().unwrap(),
            &metadata_catalog(),
            now_unix()
        )
        .is_err()
    );
    assert!(
        library
            .apply_definition_publisher_policy(&admission, Some(&candidate))
            .is_err()
    );
    assert!(
        library
            .assess_definition_operation(
                &identity,
                DefinitionOperationContext::observed(
                    DefinitionOperation::Availability,
                    false,
                    true
                )
            )
            .is_err()
    );
}

#[tokio::test]
async fn authenticated_unknown_scope_and_changed_definition_are_refused() {
    let fixture = RepositoryFixture::new();
    let key = Key::new(fixture._directory.path());
    let mut document = availability(1);
    document["operations"] = serde_json::json!(["install"]);
    let root = publish(&fixture, &key, 1, &document).await;
    assert!(acquire_policy(&fixture, &root, ID).await.is_err());
    document.as_object_mut().unwrap().remove("operations");
    document["decision"]["definition_sha256"] = Value::String("0".repeat(64));
    let root = publish(&fixture, &key, 2, &document).await;
    let candidate = acquire(&fixture, &root).await.unwrap();
    let policy = acquire_policy(&fixture, &root, ID).await.unwrap();
    let (_directory, library) = library();
    policy::install_authority_for_test(&library, &root).unwrap();
    assert!(
        library
            .apply_definition_publisher_policy(&policy, Some(&candidate))
            .is_err()
    );
    assert_eq!(count(&library, "definition_publisher_admission"), 0);
}

#[tokio::test]
async fn revocation_requires_no_candidate_and_invalidates_assessed_selection() {
    let fixture = RepositoryFixture::new();
    let key = Key::new(fixture._directory.path());
    let root = publish(&fixture, &key, 1, &availability(1)).await;
    let candidate = acquire(&fixture, &root).await.unwrap();
    let initial = acquire_policy(&fixture, &root, ID).await.unwrap();
    let (_directory, library) = library();
    policy::install_authority_for_test(&library, &root).unwrap();
    library
        .apply_definition_publisher_policy(&initial, Some(&candidate))
        .unwrap();
    let eligible = library
        .assess_definition_candidate(&candidate, "official", ID)
        .unwrap()
        .into_eligible()
        .unwrap();
    let mut document = availability(2);
    document["decision"] = serde_json::json!({"status":"revoked"});
    publish(&fixture, &key, 2, &document).await;
    let targets = metadata_targets();
    fs::remove_file(fixture.published_target(INDEX_TARGET, &targets[0].1, true)).unwrap();
    assert!(acquire(&fixture, &root).await.is_err());
    let revoked = acquire_policy(&fixture, &root, ID).await.unwrap();
    assert!(
        library
            .apply_definition_publisher_policy(&revoked, None)
            .unwrap()
    );
    assert!(library.select_definition_candidate(eligible).is_err());
    assert_eq!(
        library
            .assess_definition_candidate(&candidate, "official", ID)
            .unwrap()
            .eligibility()
            .reason,
        DefinitionEligibilityReason::PublisherRevoked
    );
    assert!(
        library
            .apply_definition_publisher_policy(&initial, Some(&candidate))
            .is_err()
    );
}

#[tokio::test]
async fn same_grant_revision_cannot_replace_authorized_bytes() {
    let fixture = RepositoryFixture::new();
    let key = Key::new(fixture._directory.path());
    let root = publish(&fixture, &key, 1, &availability(1)).await;
    let candidate = acquire(&fixture, &root).await.unwrap();
    let initial = acquire_policy(&fixture, &root, ID).await.unwrap();
    let (_directory, library) = library();
    policy::install_authority_for_test(&library, &root).unwrap();
    library
        .apply_definition_publisher_policy(&initial, Some(&candidate))
        .unwrap();
    let mut document = availability(1);
    document["grant_id"] = "replacement-grant".into();
    publish(&fixture, &key, 2, &document).await;
    let replacement = acquire_policy(&fixture, &root, ID).await.unwrap();
    assert!(
        library
            .apply_definition_publisher_policy(&replacement, Some(&candidate))
            .is_err()
    );
    assert_eq!(count(&library, "definition_publisher_admission"), 1);
}

#[tokio::test]
async fn authority_floor_prevents_metadata_replay_for_a_different_identity() {
    let fixture = RepositoryFixture::new();
    let key = Key::new(fixture._directory.path());
    let mut other = availability(1);
    other["stable_id"] = "other-definition".into();
    other["decision"] = serde_json::json!({"status":"revoked"});
    let root = publish(&fixture, &key, 1, &other).await;
    let stale = acquire_policy(&fixture, &root, "other-definition")
        .await
        .unwrap();
    publish(&fixture, &key, 2, &availability(1)).await;
    let current = acquire_policy(&fixture, &root, ID).await.unwrap();
    let candidate = acquire(&fixture, &root).await.unwrap();
    let (_directory, library) = library();
    policy::install_authority_for_test(&library, &root).unwrap();
    library
        .apply_definition_publisher_policy(&current, Some(&candidate))
        .unwrap();
    assert!(
        library
            .apply_definition_publisher_policy(&stale, None)
            .is_err()
    );
    assert_eq!(count(&library, "definition_publisher_admission"), 1);
    publish(&fixture, &key, 3, &other).await;
    let newer_other = acquire_policy(&fixture, &root, "other-definition")
        .await
        .unwrap();
    library
        .apply_definition_publisher_policy(&newer_other, None)
        .unwrap();
    assert_eq!(count(&library, "definition_publisher_admission"), 2);
    assert_eq!(
        library
            .assess_definition_candidate(&candidate, "official", ID)
            .unwrap()
            .eligibility()
            .outcome,
        DefinitionEligibilityOutcome::Eligible
    );
}

#[tokio::test]
async fn interrupted_admission_rolls_back_grant_and_authority_floor() {
    let fixture = RepositoryFixture::new();
    let key = Key::new(fixture._directory.path());
    let root = publish(&fixture, &key, 1, &availability(1)).await;
    let candidate = acquire(&fixture, &root).await.unwrap();
    let policy = acquire_policy(&fixture, &root, ID).await.unwrap();
    let (_directory, library) = library();
    policy::install_authority_for_test(&library, &root).unwrap();
    library
        .connection()
        .unwrap()
        .execute_batch(
            "CREATE TRIGGER fixture_interrupt BEFORE INSERT ON definition_publisher_policy
         BEGIN SELECT RAISE(ABORT,'fixture publication interrupted'); END;",
        )
        .unwrap();
    assert!(
        library
            .apply_definition_publisher_policy(&policy, Some(&candidate))
            .is_err()
    );
    assert_eq!(count(&library, "definition_publisher_admission"), 0);
    assert_eq!(count(&library, "definition_publisher_policy"), 0);
    let floor: Option<String> = library
        .connection()
        .unwrap()
        .query_row(
            "SELECT replay_floor_json FROM definition_publisher_authority",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(floor.is_none());
    library
        .connection()
        .unwrap()
        .execute_batch("DROP TRIGGER fixture_interrupt;")
        .unwrap();
    assert!(
        library
            .apply_definition_publisher_policy(&policy, Some(&candidate))
            .unwrap()
    );
}

async fn managed_fixture() -> (
    RepositoryFixture,
    Key,
    Vec<u8>,
    TempDir,
    Library,
    Catalog,
    crate::DefinitionAcquisitionScope,
) {
    let mut baseline = Catalog::embedded().unwrap().authoritative_document();
    baseline.ports.push(metadata_catalog().ports()[0].clone());
    let authored = Catalog::from_json(&serde_json::to_string(&baseline).unwrap()).unwrap();
    let fixture = managed_fixture_for(authored).await;
    assert!(
        fixture
            .4
            .load_catalog()
            .unwrap()
            .0
            .definition_selection(ID)
            .is_some(),
        "ordinary provider fixture must load through the unchanged embedded baseline"
    );
    fixture
}

async fn managed_fixture_for(
    authored: Catalog,
) -> (
    RepositoryFixture,
    Key,
    Vec<u8>,
    TempDir,
    Library,
    Catalog,
    crate::DefinitionAcquisitionScope,
) {
    managed_fixture_for_policy(authored, false).await
}

async fn managed_fixture_for_policy(
    authored: Catalog,
    launch_checks: bool,
) -> (
    RepositoryFixture,
    Key,
    Vec<u8>,
    TempDir,
    Library,
    Catalog,
    crate::DefinitionAcquisitionScope,
) {
    let fixture = RepositoryFixture::new();
    let key = Key::new(fixture._directory.path());
    let mut targets = repository_targets_for(&authored, ID);
    let document = managed_policy_for(&targets, launch_checks);
    targets.push((
        format!("policy/official/{ID}.json"),
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
    let candidate = acquire(&fixture, &root).await.unwrap();
    let admission = acquire_policy(&fixture, &root, ID).await.unwrap();
    let (directory, library) = library();
    policy::install_authority_for_test(&library, &root).unwrap();
    library
        .apply_definition_publisher_policy(&admission, Some(&candidate))
        .unwrap();
    let eligible = library
        .assess_definition_candidate(&candidate, "official", ID)
        .unwrap()
        .into_eligible()
        .unwrap();
    library.select_definition_candidate(eligible).unwrap();
    let catalog = crate::definition_candidate::selection::load_selected_definition_catalog(
        &library.connection().unwrap(),
        &authored,
        now_unix(),
    )
    .unwrap()
    .unwrap()
    .0;
    let scope = policy::acquisition_scope(&library, &catalog, ID)
        .unwrap()
        .unwrap();
    (fixture, key, root, directory, library, catalog, scope)
}

fn managed_policy_for(targets: &[(String, Vec<u8>)], launch_checks: bool) -> Value {
    let mut document = availability_for(targets, ID, 1);
    document["policy_schema"] = serde_json::json!(if launch_checks { 3 } else { 2 });
    if launch_checks {
        document["decision"]["scoped_launch_checks"] = 1.into();
    }
    document["grant_id"] = serde_json::json!("managed-github-v1-fixture");
    for field in [
        "status",
        "repository_id",
        "artifact_hosts",
        "max_redirects",
        "operations",
    ] {
        document["decision"][field] = managed_github(1)["decision"][field].clone();
    }
    document
}

// Owned HTTP fixtures exercise real reqwest consumers without pretending to
// qualify production TLS, publisher custody, or installed native behavior.
struct AcquisitionHttp {
    origin: String,
    responses: std::sync::Arc<std::sync::Mutex<std::collections::VecDeque<Vec<u8>>>>,
    requests: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl AcquisitionHttp {
    fn new() -> Self {
        use std::io::{Read, Write};
        use std::sync::{
            Arc, Mutex,
            atomic::{AtomicBool, Ordering},
        };
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let responses = Arc::new(Mutex::new(std::collections::VecDeque::<Vec<u8>>::new()));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let (output, captured, stopping) = (responses.clone(), requests.clone(), stop.clone());
        let thread = std::thread::spawn(move || {
            while !stopping.load(Ordering::Acquire) {
                let (mut stream, _) = match listener.accept() {
                    Ok(pair) => pair,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(std::time::Duration::from_millis(5));
                        continue;
                    }
                    Err(error) => panic!("fixture listener: {error}"),
                };
                // Windows can inherit nonblocking mode from the listener.
                // This owned request uses the existing bounded read timeout.
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(2)))
                    .unwrap();
                stream
                    .set_write_timeout(Some(std::time::Duration::from_secs(2)))
                    .unwrap();
                let mut buffer = vec![0u8; 16 * 1024];
                let size = stream.read(&mut buffer).unwrap();
                captured
                    .lock()
                    .unwrap()
                    .push(String::from_utf8_lossy(&buffer[..size]).into_owned());
                let response = output
                    .lock()
                    .unwrap()
                    .pop_front()
                    .expect("unexpected acquisition request");
                let _ = stream.write_all(&response);
            }
        });
        Self {
            origin,
            responses,
            requests,
            stop,
            thread: Some(thread),
        }
    }
    fn json(&self, body: Value) {
        self.body(&body.to_string());
    }
    fn body(&self, body: &str) {
        self.bytes(body.as_bytes());
    }
    fn bytes(&self, body: &[u8]) {
        let mut response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        response.extend_from_slice(body);
        self.responses.lock().unwrap().push_back(response);
    }
    fn redirect(&self, url: &str) {
        self.responses.lock().unwrap().push_back(format!(
            "HTTP/1.1 302 Found\r\nLocation: {url}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").into_bytes());
    }
    fn release(&self, digest: bool) -> Value {
        serde_json::json!([{
            "tag_name":"v1", "draft":false, "prerelease":false, "published_at":null,
            "assets":[{
                "name":"game-linux-x86_64.zip", "browser_download_url":format!("{}/game.zip", self.origin),
                "size":1, "digest": if digest { Some(format!("sha256:{}", "a".repeat(64))) } else { None },
            },{
                "name":"SHA256SUMS", "browser_download_url":format!("{}/SHA256SUMS", self.origin),
                "size":128, "digest":null,
            }]
        }])
    }
}
impl Drop for AcquisitionHttp {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::Release);
        self.thread.take().unwrap().join().unwrap();
    }
}

#[tokio::test]
async fn managed_repository_identity_is_checked_before_scoped_cache_reuse() {
    use crate::ReleaseProvider;
    let (_fixture, _key, _root, _directory, library, catalog, mut scope) = managed_fixture().await;
    let server = AcquisitionHttp::new();
    scope.fixture_origin = Some(server.origin.clone());
    let provider =
        crate::GithubReleaseProvider::with_api_root_and_library(server.origin.clone(), library)
            .unwrap();
    let port = catalog.port(ID).unwrap();
    server.json(serde_json::json!({"id":scope.repository_id,"archived":false}));
    server.json(server.release(true));
    let resolved = provider
        .resolve_scoped(
            port,
            ReleaseChannel::Stable,
            crate::Platform::LinuxX86_64,
            Some(&scope),
        )
        .await
        .unwrap();
    assert!(resolved.scope.is_some());
    assert_eq!(server.requests.lock().unwrap().len(), 2);
    server.json(serde_json::json!({"id":scope.repository_id,"archived":true}));
    provider
        .resolve_scoped(
            port,
            ReleaseChannel::Stable,
            crate::Platform::LinuxX86_64,
            Some(&scope),
        )
        .await
        .unwrap();
    assert_eq!(
        server.requests.lock().unwrap().len(),
        3,
        "only metadata is requested before valid scoped cache reuse"
    );
    for repository in [
        serde_json::json!({"id":scope.repository_id + 1,"archived":false}),
        serde_json::json!({"archived":false}),
    ] {
        server.json(repository);
        assert!(
            provider
                .resolve_scoped(
                    port,
                    ReleaseChannel::Stable,
                    crate::Platform::LinuxX86_64,
                    Some(&scope)
                )
                .await
                .is_err()
        );
    }
    assert_eq!(server.requests.lock().unwrap().len(), 5);
    for request in server.requests.lock().unwrap().iter() {
        let lower = request.to_ascii_lowercase();
        assert!(!lower.contains("authorization:"));
        assert!(!lower.contains("if-none-match:"));
    }
    assert!(server.responses.lock().unwrap().is_empty());
}

#[tokio::test]
async fn managed_checksum_redirect_cannot_contact_an_ungranted_origin() {
    use crate::ReleaseProvider;
    let (_fixture, _key, _root, _directory, _library, catalog, mut scope) = managed_fixture().await;
    let server = AcquisitionHttp::new();
    let denied = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    denied.set_nonblocking(true).unwrap();
    scope.fixture_origin = Some(server.origin.clone());
    server.json(serde_json::json!({"id":scope.repository_id,"archived":false}));
    server.json(server.release(false));
    server.redirect(&format!(
        "http://{}/SHA256SUMS",
        denied.local_addr().unwrap()
    ));
    let provider = crate::GithubReleaseProvider::with_api_root(server.origin.clone()).unwrap();
    assert!(
        provider
            .resolve_scoped(
                catalog.port(ID).unwrap(),
                ReleaseChannel::Stable,
                crate::Platform::LinuxX86_64,
                Some(&scope)
            )
            .await
            .is_err()
    );
    assert_eq!(server.requests.lock().unwrap().len(), 3);
    assert_eq!(
        denied.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    assert!(server.responses.lock().unwrap().is_empty());
}

#[tokio::test]
async fn managed_scope_withdrawal_invalidates_captured_proof_and_missing_admission_never_falls_back()
 {
    let (fixture, key, root, _directory, library, catalog, scope) = managed_fixture().await;
    scope.require_current().unwrap();
    assert!(crate::definition_acquisition::refuse_restricted_adoption(&catalog, ID).is_err());
    let identity = catalog.definition_selection(ID).unwrap();
    let snapshot = catalog.definition_snapshot(ID).unwrap();
    assert!(
        library
            .restore_retained_definition_admission(identity, snapshot, "active")
            .is_err()
    );
    let mut revoked = managed_github(2);
    revoked["decision"] = serde_json::json!({"status":"revoked"});
    publish(&fixture, &key, 2, &revoked).await;
    let withdrawal = acquire_policy(&fixture, &root, ID).await.unwrap();
    library
        .apply_definition_publisher_policy(&withdrawal, None)
        .unwrap();
    assert!(scope.require_current().is_err());
    assert!(policy::acquisition_scope(&library, &catalog, ID).is_err());
    library
        .connection()
        .unwrap()
        .execute("DELETE FROM definition_publisher_admission", [])
        .unwrap();
    assert!(policy::acquisition_scope(&library, &catalog, ID).is_err());
    for operation in [
        DefinitionOperation::Install,
        DefinitionOperation::Prepare,
        DefinitionOperation::Launch,
    ] {
        assert_ne!(
            library
                .assess_definition_operation(
                    identity,
                    DefinitionOperationContext::observed(
                        operation,
                        operation == DefinitionOperation::Launch,
                        true
                    )
                )
                .unwrap()
                .outcome,
            DefinitionEligibilityOutcome::Eligible
        );
    }
    assert_eq!(count(&library, "installs"), 0);
}

#[tokio::test]
async fn managed_installer_requires_resolver_proof_and_refuses_artifact_redirect_before_contact() {
    use crate::ReleaseProvider;
    let (_fixture, _key, _root, _directory, library, catalog, mut scope) = managed_fixture().await;
    let server = AcquisitionHttp::new();
    let denied = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    denied.set_nonblocking(true).unwrap();
    scope.fixture_origin = Some(server.origin.clone());
    server.json(serde_json::json!({"id":scope.repository_id,"archived":false}));
    server.json(server.release(true));
    let provider = crate::GithubReleaseProvider::with_api_root(server.origin.clone()).unwrap();
    let resolution = provider
        .resolve_scoped(
            catalog.port(ID).unwrap(),
            ReleaseChannel::Stable,
            crate::Platform::LinuxX86_64,
            Some(&scope),
        )
        .await
        .unwrap();
    let installer = crate::Installer::new(library.clone()).unwrap();
    let operation = crate::operation::OperationCoordinator::new("install", None);
    let unqualified = crate::InstallRequest {
        port_id: ID.into(),
        release: resolution.release.clone(),
        output_root: library.versions_dir().join(ID),
        activate: true,
        managed: None,
        qualification: crate::InstallQualification::from_catalog(
            &catalog,
            ID,
            crate::Platform::LinuxX86_64,
        )
        .unwrap(),
    };
    assert_eq!(
        installer
            .install(unqualified, &operation, |_| {})
            .await
            .unwrap_err()
            .code,
        ErrorCode::Unsupported
    );
    assert_eq!(server.requests.lock().unwrap().len(), 2);
    assert!(
        crate::operation::OperationStore::new(library.clone())
            .all()
            .unwrap()
            .is_empty()
    );
    let mut changed = catalog.port(ID).unwrap().clone();
    changed.release.repository = "another/repository".into();
    assert!(
        provider
            .resolve_scoped(
                &changed,
                ReleaseChannel::Stable,
                crate::Platform::LinuxX86_64,
                Some(&scope)
            )
            .await
            .is_err()
    );
    assert_eq!(server.requests.lock().unwrap().len(), 2);
    server.redirect(&format!("http://{}/game.zip", denied.local_addr().unwrap()));
    let qualified = crate::InstallRequest {
        port_id: ID.into(),
        release: resolution.release.clone(),
        output_root: library.versions_dir().join(ID),
        activate: true,
        managed: None,
        qualification: crate::InstallQualification::from_catalog(
            &catalog,
            ID,
            crate::Platform::LinuxX86_64,
        )
        .unwrap()
        .with_acquisition_resolution(resolution)
        .unwrap(),
    };
    let error = installer
        .install(qualified, &operation, |_| {})
        .await
        .unwrap_err();
    assert!(
        error.message.contains("redirect") || error.message.contains("admitted HTTPS scope"),
        "{}",
        error.message
    );
    assert_eq!(server.requests.lock().unwrap().len(), 3);
    assert_eq!(
        denied.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    assert_eq!(count(&library, "installs"), 0);
}

#[tokio::test]
async fn managed_ordinary_artifacts_and_compatible_correction_retain_exact_contract() {
    managed_ordinary_lifecycle(None, None).await;
}

type ManagedAcquisitionDriver<'a> = Option<
    &'a mut dyn FnMut(&Library, &AcquisitionHttp, u64, &str, &Value, &[u8]) -> crate::InstallRecord,
>;

type ManagedStageObserver<'a> = Option<&'a mut dyn FnMut(&Library, &str)>;

fn observe_managed_stage(observer: &mut ManagedStageObserver<'_>, library: &Library, stage: &str) {
    if let Some(observer) = observer.as_mut() {
        observer(library, stage);
    }
}

async fn managed_ordinary_lifecycle(
    mut observer: ManagedStageObserver<'_>,
    mut acquisition: ManagedAcquisitionDriver<'_>,
) {
    use crate::ReleaseProvider;
    use std::io::{Cursor, Write};
    let phase_clock = std::time::Instant::now();
    let phase = |label: &str| {
        println!(
            "managed ordinary lifecycle {label}: {:?}",
            phase_clock.elapsed()
        );
    };
    phase("catalog:start");
    let platform = crate::Platform::current().unwrap();
    let executable = if cfg!(windows) {
        "fixture.exe"
    } else {
        "fixture"
    };
    let mut baseline = Catalog::embedded().unwrap().authoritative_document();
    let mut port = metadata_catalog().ports()[0].clone();
    port.platforms = vec![platform];
    port.executable_hints = std::collections::BTreeMap::from([(platform, vec![executable.into()])]);
    baseline.ports.push(port);
    let authored = Catalog::from_json(&serde_json::to_string(&baseline).unwrap()).unwrap();
    phase("catalog:complete");
    phase("managed-fixture:start");
    let (fixture, key, root, _directory, library, catalog, mut scope) =
        managed_fixture_for(authored).await;
    phase("managed-fixture:complete");
    phase("ordinary-load:start");
    assert!(
        library
            .load_catalog()
            .unwrap()
            .0
            .definition_selection(ID)
            .is_some()
    );
    phase("ordinary-load:complete");
    observe_managed_stage(&mut observer, &library, "new-definition");
    let server = AcquisitionHttp::new();
    scope.fixture_origin = Some(server.origin.clone());
    let installer = crate::Installer::new(library.clone()).unwrap();
    let mut delivered = Vec::new();
    for version in ["v1", "v2"] {
        // A fresh provider models the next ordinary client session. The earlier
        // cache test separately qualifies reuse within the live session's TTL.
        let provider = crate::GithubReleaseProvider::with_api_root(server.origin.clone()).unwrap();
        phase(&format!("{version}:zip:start"));
        let payload = format!("owned synthetic ordinary artifact {version}");
        let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
        archive
            .start_file(
                executable,
                zip::write::SimpleFileOptions::default().unix_permissions(0o755),
            )
            .unwrap();
        archive.write_all(payload.as_bytes()).unwrap();
        let bytes = archive.finish().unwrap().into_inner();
        let digest = hex::encode(Sha256::digest(&bytes));
        phase(&format!("{version}:zip:complete"));
        let mut release = server.release(true);
        release[0]["tag_name"] = version.into();
        release[0]["assets"][0]["name"] = format!("game-{}.zip", platform.asset_tokens()[0]).into();
        release[0]["assets"][0]["size"] = bytes.len().into();
        release[0]["assets"][0]["digest"] = format!("sha256:{digest}").into();
        let installed = if let Some(acquire) = acquisition.as_mut() {
            acquire(
                &library,
                &server,
                scope.repository_id,
                version,
                &release,
                &bytes,
            )
        } else {
            server.json(serde_json::json!({"id":scope.repository_id,"archived":false}));
            server.json(release);
            phase(&format!("{version}:resolve:start"));
            let resolution = provider
                .resolve_scoped(
                    catalog.port(ID).unwrap(),
                    ReleaseChannel::Stable,
                    platform,
                    Some(&scope),
                )
                .await
                .unwrap();
            phase(&format!("{version}:resolve:complete"));
            server.bytes(&bytes);
            let request = crate::InstallRequest {
                port_id: ID.into(),
                release: resolution.release.clone(),
                output_root: library.versions_dir().join(ID),
                activate: true,
                managed: None,
                qualification: crate::InstallQualification::from_catalog(&catalog, ID, platform)
                    .unwrap()
                    .with_acquisition_resolution(resolution)
                    .unwrap(),
            };
            let operation = crate::operation::OperationCoordinator::new("install", None);
            phase(&format!("{version}:install:start"));
            installer
                .install(request, &operation, |_| {})
                .await
                .unwrap()
        };
        phase(&format!("{version}:install:complete"));
        phase(&format!("{version}:retained-readback:start"));
        assert_eq!(installed.version, version);
        assert_eq!(installed.artifact.sha256, digest);
        assert_eq!(
            fs::read(installed.path.join(executable)).unwrap(),
            payload.as_bytes()
        );
        let retained = installer.retained_catalog(&installed).unwrap().unwrap();
        assert_eq!(
            retained.definition_selection(ID),
            catalog.definition_selection(ID)
        );
        assert_eq!(
            serde_json::to_value(retained.port(ID).unwrap()).unwrap(),
            serde_json::to_value(catalog.port(ID).unwrap()).unwrap()
        );
        delivered.push(installed);
        phase(&format!("{version}:retained-readback:complete"));
        observe_managed_stage(&mut observer, &library, version);
    }
    phase("ordinary-status:start");
    let status = library.status(ID, ReleaseChannel::Stable).unwrap();
    assert_eq!(status.active.unwrap().id, delivered[1].id);
    assert_eq!(status.previous.unwrap().id, delivered[0].id);
    assert_eq!(
        fs::read(delivered[0].path.join(executable)).unwrap(),
        b"owned synthetic ordinary artifact v1"
    );
    assert_eq!(
        server.requests.lock().unwrap().len(),
        if acquisition.is_some() { 38 } else { 6 }
    );
    assert!(
        server
            .requests
            .lock()
            .unwrap()
            .iter()
            .all(|request| { !request.to_ascii_lowercase().contains("authorization:") })
    );
    assert!(server.responses.lock().unwrap().is_empty());

    // The same capable service must consume a signed presentation correction
    // without changing either previously admitted installation contract.
    phase("ordinary-status:complete");
    phase("ordinary-service:start");
    let before = PortcoveService::new(library.clone())
        .unwrap()
        .status(ID)
        .unwrap();
    let launch = before
        .definition_operations
        .iter()
        .find(|assessment| assessment.operation == DefinitionOperation::Launch)
        .unwrap();
    assert!(launch.retained);
    assert_eq!(
        launch.eligibility.outcome,
        DefinitionEligibilityOutcome::Eligible
    );
    phase("ordinary-service:complete");
    phase("retained-trees:start");
    let retained_trees: Vec<_> = delivered
        .iter()
        .map(|installed| crate::library_transfer::reviewed_tree(&installed.path).unwrap())
        .collect();
    let user = library.user_dir(ID);
    fs::create_dir_all(user.join("saves")).unwrap();
    fs::create_dir_all(user.join("config")).unwrap();
    fs::write(user.join("saves/progress.bin"), b"owned retained progress").unwrap();
    fs::write(user.join("config/settings.json"), b"{\"owned\":true}").unwrap();
    let user_tree = crate::library_transfer::reviewed_tree(&user).unwrap();

    phase("retained-trees:complete");

    let corrected = compatible_correction_catalog(&catalog);
    let correction = crate::test_fixture::IndexedCatalogFixture::new(&corrected, ID);
    for definition_revision in [8, 9] {
        phase(&format!("revision-{definition_revision}:acquire:start"));
        let (candidate, admission) =
            acquire_compatible_correction(&fixture, &key, &root, &correction, definition_revision)
                .await;
        phase(&format!("revision-{definition_revision}:acquire:complete"));
        phase(&format!("revision-{definition_revision}:select:start"));
        library
            .apply_definition_publisher_policy(&admission, Some(&candidate))
            .unwrap();
        let eligible = library
            .assess_definition_candidate(&candidate, "official", ID)
            .unwrap()
            .into_eligible()
            .unwrap();
        library.select_definition_candidate(eligible).unwrap();

        phase(&format!("revision-{definition_revision}:select:complete"));
        phase(&format!("revision-{definition_revision}:reopen:start"));
        let reopened = PortcoveService::new(library.clone()).unwrap();
        phase(&format!(
            "revision-{definition_revision}:reopen:constructed"
        ));
        assert_eq!(
            reopened.catalog().port(ID).unwrap().summary,
            "Reviewed presentation correction"
        );
        phase(&format!(
            "revision-{definition_revision}:reopen:catalog-checked"
        ));
        let after = reopened.status(ID).unwrap();
        phase(&format!("revision-{definition_revision}:reopen:complete"));
        phase(&format!(
            "revision-{definition_revision}:retained-readback:start"
        ));
        assert_eq!(after.active.as_ref().unwrap().id, delivered[1].id);
        assert_eq!(after.previous.as_ref().unwrap().id, delivered[0].id);
        for (installed, tree) in delivered.iter().zip(&retained_trees) {
            assert_eq!(
                crate::library_transfer::reviewed_tree(&installed.path).unwrap(),
                *tree
            );
            let retained = installer.retained_catalog(installed).unwrap().unwrap();
            assert_eq!(
                retained.definition_selection(ID),
                catalog.definition_selection(ID)
            );
        }
        assert_eq!(
            crate::library_transfer::reviewed_tree(&user).unwrap(),
            user_tree
        );
        let launch = after
            .definition_operations
            .iter()
            .find(|assessment| assessment.operation == DefinitionOperation::Launch)
            .unwrap();
        assert!(launch.retained);
        assert_eq!(
            launch.eligibility.outcome,
            DefinitionEligibilityOutcome::Eligible
        );
        phase(&format!(
            "revision-{definition_revision}:retained-readback:complete"
        ));
        observe_managed_stage(
            &mut observer,
            &library,
            &format!("correction-{definition_revision}"),
        );
    }
    if observer.is_some() {
        // Qualify the unchanged consumers against an authenticated narrowing,
        // then restoration. Neither may revive the old installed authorization.
        for (revision, redirects) in [(10, Some(4)), (11, None)] {
            let (candidate, admission) = acquire_compatible_correction_with_redirects(
                &fixture,
                &key,
                &root,
                &correction,
                revision,
                redirects,
            )
            .await;
            library
                .apply_definition_publisher_policy(&admission, Some(&candidate))
                .unwrap();
            let eligible = library
                .assess_definition_candidate(&candidate, "official", ID)
                .unwrap()
                .into_eligible()
                .unwrap();
            library.select_definition_candidate(eligible).unwrap();
            let after = PortcoveService::new(library.clone())
                .unwrap()
                .status(ID)
                .unwrap();
            let launch = after
                .definition_operations
                .iter()
                .find(|assessment| assessment.operation == DefinitionOperation::Launch)
                .unwrap();
            assert!(launch.retained);
            assert_eq!(
                launch.eligibility.outcome,
                DefinitionEligibilityOutcome::Hold
            );
            assert_eq!(
                launch.eligibility.reason,
                DefinitionEligibilityReason::RecordedIdentityChanged
            );
            for (installed, tree) in delivered.iter().zip(&retained_trees) {
                assert_eq!(
                    crate::library_transfer::reviewed_tree(&installed.path).unwrap(),
                    *tree
                );
                assert_eq!(
                    installer
                        .retained_catalog(installed)
                        .unwrap()
                        .unwrap()
                        .definition_selection(ID),
                    catalog.definition_selection(ID)
                );
            }
            assert_eq!(
                crate::library_transfer::reviewed_tree(&user).unwrap(),
                user_tree
            );
            observe_managed_stage(
                &mut observer,
                &library,
                if redirects.is_some() {
                    "authorization-narrowed"
                } else {
                    "authorization-restored"
                },
            );
        }
    }
    phase("complete");
}

async fn acquire_compatible_correction(
    fixture: &RepositoryFixture,
    key: &Key,
    root: &[u8],
    correction: &crate::test_fixture::IndexedCatalogFixture<'_>,
    definition_revision: u64,
) -> (
    crate::AuthenticatedDefinitionCandidate,
    crate::AuthenticatedDefinitionPublisherPolicy,
) {
    acquire_compatible_correction_with_redirects(
        fixture,
        key,
        root,
        correction,
        definition_revision,
        None,
    )
    .await
}

async fn acquire_compatible_correction_with_redirects(
    fixture: &RepositoryFixture,
    key: &Key,
    root: &[u8],
    correction: &crate::test_fixture::IndexedCatalogFixture<'_>,
    definition_revision: u64,
    max_redirects: Option<u8>,
) -> (
    crate::AuthenticatedDefinitionCandidate,
    crate::AuthenticatedDefinitionPublisherPolicy,
) {
    let policy_revision = definition_revision - 6;
    let bundle = correction.at_revision(definition_revision);
    let mut targets = vec![(INDEX_TARGET.to_owned(), bundle.index)];
    targets.extend(bundle.contents);
    let mut document = availability_for(&targets, ID, policy_revision);
    document["policy_schema"] = serde_json::json!(2);
    document["grant_id"] = serde_json::json!("managed-github-v1-fixture");
    let managed = managed_github(2);
    for field in [
        "status",
        "repository_id",
        "artifact_hosts",
        "max_redirects",
        "operations",
    ] {
        document["decision"][field] = managed["decision"][field].clone();
    }
    if let Some(max_redirects) = max_redirects {
        document["decision"]["max_redirects"] = max_redirects.into();
    }
    targets.push((
        format!("policy/official/{ID}.json"),
        serde_json::to_vec(&document).unwrap(),
    ));
    let corrected_root = fixture
        .publish_with_policy(
            &targets,
            true,
            &DEFINITION_ROLE_PATHS,
            later(),
            Some((key, policy_revision)),
        )
        .await;
    assert_eq!(corrected_root.as_slice(), root);
    let candidate = acquire(fixture, root).await.unwrap();
    let admission = acquire_policy(fixture, root, ID).await.unwrap();
    (candidate, admission)
}

fn compatible_correction_catalog(catalog: &Catalog) -> Catalog {
    let mut corrected = catalog.authoritative_document();
    corrected
        .ports
        .iter_mut()
        .find(|port| port.id == ID)
        .unwrap()
        .summary = "Reviewed presentation correction".into();
    Catalog::from_json(&serde_json::to_string(&corrected).unwrap()).unwrap()
}

#[tokio::test]
async fn managed_compatible_corrections_refuse_old_acquisition_and_changed_retained_identity() {
    // These supplied operation contexts consume stored admission, not installed
    // payloads. Ordinary embedded discovery and both real artifacts stay above.
    let (fixture, key, root, _directory, library, catalog, scope) =
        managed_fixture_for(metadata_catalog()).await;
    let old_identity = catalog.definition_selection(ID).unwrap();
    let require_retained_launch = || {
        assert_eq!(
            library
                .assess_definition_operation(
                    old_identity,
                    DefinitionOperationContext::observed(DefinitionOperation::Launch, true, true),
                )
                .unwrap()
                .outcome,
            DefinitionEligibilityOutcome::Eligible,
        );
        assert!(
            policy::continues_retained_launch(&library.connection().unwrap(), old_identity)
                .unwrap()
        );
        let floor: u64 = library
            .connection()
            .unwrap()
            .query_row(
                "SELECT retained_launch_revision_floor FROM definition_publisher_admission",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(floor, 1);
    };
    require_retained_launch();
    let corrected = compatible_correction_catalog(&catalog);
    let correction = crate::test_fixture::IndexedCatalogFixture::new(&corrected, ID);
    for definition_revision in [8, 9] {
        let (candidate, admission) =
            acquire_compatible_correction(&fixture, &key, &root, &correction, definition_revision)
                .await;
        library
            .apply_definition_publisher_policy(&admission, Some(&candidate))
            .unwrap();
        let eligible = library
            .assess_definition_candidate(&candidate, "official", ID)
            .unwrap()
            .into_eligible()
            .unwrap();
        library.select_definition_candidate(eligible).unwrap();
        require_retained_launch();
        for operation in [
            DefinitionOperation::Install,
            DefinitionOperation::Update,
            DefinitionOperation::Prepare,
        ] {
            assert_eq!(
                library
                    .assess_definition_operation(
                        old_identity,
                        DefinitionOperationContext::observed(operation, true, true)
                    )
                    .unwrap()
                    .reason,
                DefinitionEligibilityReason::MetadataReplay
            );
        }
        assert!(policy::validate_current_acquisition(&scope).is_err());
        assert!(policy::acquisition_scope(&library, &catalog, ID).is_err());
        assert_eq!(
            library
                .assess_definition_operation(
                    old_identity,
                    DefinitionOperationContext::observed(DefinitionOperation::Launch, true, false)
                )
                .unwrap()
                .reason,
            DefinitionEligibilityReason::LocalIntegrityFailed
        );
        let mut changed = old_identity.clone();
        changed.grant_id = "managed-github-v1-different".into();
        assert_eq!(
            library
                .assess_definition_operation(
                    &changed,
                    DefinitionOperationContext::observed(DefinitionOperation::Launch, true, true)
                )
                .unwrap()
                .reason,
            DefinitionEligibilityReason::RecordedIdentityChanged
        );
        let selection = library.definition_selection_status().unwrap();
        assert!(
            !library
                .apply_definition_publisher_policy(&admission, Some(&candidate))
                .unwrap()
        );
        assert_eq!(
            serde_json::to_value(library.definition_selection_status().unwrap()).unwrap(),
            serde_json::to_value(selection).unwrap()
        );
    }
}

#[tokio::test]
async fn managed_historical_admission_upgrade_preserves_retained_installation_and_player_data() {
    use crate::ReleaseProvider;
    use std::io::{Cursor, Write};
    let platform = crate::Platform::current().unwrap();
    let executable = if cfg!(windows) {
        "fixture.exe"
    } else {
        "fixture"
    };
    let mut baseline = metadata_catalog().authoritative_document();
    let mut port = metadata_catalog().ports()[0].clone();
    port.platforms = vec![platform];
    port.executable_hints = std::collections::BTreeMap::from([(platform, vec![executable.into()])]);
    baseline.ports[0] = port;
    let authored = Catalog::from_json(&serde_json::to_string(&baseline).unwrap()).unwrap();
    let (fixture, key, root, _directory, library, catalog, mut scope) =
        managed_fixture_for(authored).await;
    let server = AcquisitionHttp::new();
    scope.fixture_origin = Some(server.origin.clone());
    let installer = crate::Installer::new(library.clone()).unwrap();
    let mut delivered = Vec::new();
    for version in ["v1"] {
        // A fresh provider models the next ordinary client session. The earlier
        // cache test separately qualifies reuse within the live session's TTL.
        let provider = crate::GithubReleaseProvider::with_api_root(server.origin.clone()).unwrap();
        let payload = format!("owned synthetic ordinary artifact {version}");
        let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
        archive
            .start_file(
                executable,
                zip::write::SimpleFileOptions::default().unix_permissions(0o755),
            )
            .unwrap();
        archive.write_all(payload.as_bytes()).unwrap();
        let bytes = archive.finish().unwrap().into_inner();
        let digest = hex::encode(Sha256::digest(&bytes));
        server.json(serde_json::json!({"id":scope.repository_id,"archived":false}));
        let mut release = server.release(true);
        release[0]["tag_name"] = version.into();
        release[0]["assets"][0]["name"] = format!("game-{}.zip", platform.asset_tokens()[0]).into();
        release[0]["assets"][0]["size"] = bytes.len().into();
        release[0]["assets"][0]["digest"] = format!("sha256:{digest}").into();
        server.json(release);
        let resolution = provider
            .resolve_scoped(
                catalog.port(ID).unwrap(),
                ReleaseChannel::Stable,
                platform,
                Some(&scope),
            )
            .await
            .unwrap();
        server.bytes(&bytes);
        let request = crate::InstallRequest {
            port_id: ID.into(),
            release: resolution.release.clone(),
            output_root: library.versions_dir().join(ID),
            activate: true,
            managed: None,
            qualification: crate::InstallQualification::from_catalog(&catalog, ID, platform)
                .unwrap()
                .with_acquisition_resolution(resolution)
                .unwrap(),
        };
        let operation = crate::operation::OperationCoordinator::new("install", None);
        let installed = installer
            .install(request, &operation, |_| {})
            .await
            .unwrap();
        assert_eq!(installed.version, version);
        assert_eq!(installed.artifact.sha256, digest);
        assert_eq!(
            fs::read(installed.path.join(executable)).unwrap(),
            payload.as_bytes()
        );
        let retained = installer.retained_catalog(&installed).unwrap().unwrap();
        assert_eq!(
            retained.definition_selection(ID),
            catalog.definition_selection(ID)
        );
        assert_eq!(
            serde_json::to_value(retained.port(ID).unwrap()).unwrap(),
            serde_json::to_value(catalog.port(ID).unwrap()).unwrap()
        );
        delivered.push(installed);
    }
    let retained_trees: Vec<_> = delivered
        .iter()
        .map(|installed| crate::library_transfer::reviewed_tree(&installed.path).unwrap())
        .collect();
    let user = library.user_dir(ID);
    fs::create_dir_all(user.join("saves")).unwrap();
    fs::create_dir_all(user.join("config")).unwrap();
    fs::write(user.join("saves/progress.bin"), b"owned retained progress").unwrap();
    fs::write(user.join("config/settings.json"), b"{\"owned\":true}").unwrap();
    let user_tree = crate::library_transfer::reviewed_tree(&user).unwrap();

    // Admit a genuinely signed newer policy with the same authorization. The
    // real installed contract remains at revision 1; schema 33 had no evidence
    // from which to infer continuity across that earlier admission.
    let mut targets = repository_targets_for(&catalog, ID);
    let mut document = managed_policy_for(&targets, false);
    document["policy_revision"] = serde_json::json!(3);
    targets.push((
        format!("policy/official/{ID}.json"),
        serde_json::to_vec(&document).unwrap(),
    ));
    let current_root = fixture
        .publish_with_policy(
            &targets,
            true,
            &DEFINITION_ROLE_PATHS,
            later(),
            Some((&key, 3)),
        )
        .await;
    assert_eq!(current_root, root);
    let candidate = acquire(&fixture, &root).await.unwrap();
    let admission = acquire_policy(&fixture, &root, ID).await.unwrap();
    assert!(
        library
            .apply_definition_publisher_policy(&admission, Some(&candidate))
            .unwrap()
    );
    assert_eq!(catalog.definition_selection(ID).unwrap().policy_revision, 1);
    let snapshot = |library: &Library| {
        let conn = library.connection().unwrap();
        let admission: (String, String, String) = conn.query_row(
            "SELECT anchor_sha256,policy_json,provenance_json FROM definition_publisher_admission",
            [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).unwrap();
        let authority: (String, String, String) = conn.query_row(
            "SELECT anchor_sha256,trusted_root_json,replay_floor_json FROM definition_publisher_authority",
            [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).unwrap();
        (admission, authority)
    };
    let admitted_bytes = snapshot(&library);
    // Recreate the exact historical schema-33 admission, retaining its signed
    // bytes and current policy but removing information that schema never knew.
    assert_eq!(count(&library, "definition_launch_assessments"), 0);
    assert_eq!(count(&library, "definition_launch_decisions"), 0);
    library.connection().unwrap().execute_batch(
        "BEGIN IMMEDIATE;
         CREATE TABLE historical_admission (
           namespace TEXT NOT NULL,stable_id TEXT NOT NULL,
           anchor_sha256 TEXT NOT NULL REFERENCES definition_publisher_authority(anchor_sha256),
           policy_json TEXT NOT NULL CHECK(length(policy_json)<=65536),
           provenance_json TEXT NOT NULL CHECK(length(provenance_json)<=16384),
           PRIMARY KEY(namespace,stable_id));
         INSERT INTO historical_admission SELECT namespace,stable_id,anchor_sha256,policy_json,provenance_json
           FROM definition_publisher_admission;
         DROP TABLE definition_publisher_admission;
         ALTER TABLE historical_admission RENAME TO definition_publisher_admission;
         DROP TABLE definition_launch_assessments;
         DROP TABLE definition_launch_decisions;
         DELETE FROM schema_migrations WHERE version>33;
         COMMIT;"
    ).unwrap();
    let historical_root = library.root().to_path_buf();
    assert!(
        Library::open(&historical_root).is_err(),
        "migration must respect live library users"
    );
    drop(installer);
    drop(scope);
    drop(library);
    let upgraded = Library::open(&historical_root).unwrap();
    let floor: u64 = upgraded
        .connection()
        .unwrap()
        .query_row(
            "SELECT retained_launch_revision_floor FROM definition_publisher_admission",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        floor, 3,
        "an upgrade cannot invent prior authorization continuity"
    );
    assert_eq!(snapshot(&upgraded), admitted_bytes);
    let marker: u64 = upgraded
        .connection()
        .unwrap()
        .query_row(
            "SELECT launch_assessment_revision FROM definition_publisher_admission",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(marker, 0);
    assert_eq!(count(&upgraded, "definition_launch_assessments"), 0);
    assert_eq!(count(&upgraded, "definition_launch_decisions"), 0);
    assert_eq!(
        upgraded
            .assess_definition_operation(
                catalog.definition_selection(ID).unwrap(),
                DefinitionOperationContext::observed(DefinitionOperation::Launch, true, true)
            )
            .unwrap()
            .reason,
        DefinitionEligibilityReason::RecordedIdentityChanged
    );
    for (installed, tree) in delivered.iter().zip(&retained_trees) {
        assert_eq!(
            crate::library_transfer::reviewed_tree(&installed.path).unwrap(),
            *tree
        );
    }
    assert_eq!(
        crate::library_transfer::reviewed_tree(&user).unwrap(),
        user_tree
    );
    assert!(
        crate::operation::OperationStore::new(upgraded)
            .all()
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn managed_authorization_changes_and_restoration_cannot_revive_old_launch() {
    for change in [
        "repository_id",
        "artifact_hosts",
        "max_redirects",
        "grant_id",
        "revoked",
        "availability",
    ] {
        let (fixture, key, root, _directory, library, catalog, _scope) =
            managed_fixture_for(metadata_catalog()).await;
        let identity = catalog.definition_selection(ID).unwrap();
        for revision in [2, 3] {
            let mut targets = repository_targets_for(&catalog, ID);
            let mut document = availability_for(&targets, ID, revision);
            document["policy_schema"] = 2.into();
            document["grant_id"] = "managed-github-v1-fixture".into();
            for field in [
                "status",
                "repository_id",
                "artifact_hosts",
                "max_redirects",
                "operations",
            ] {
                document["decision"][field] = managed_github(revision)["decision"][field].clone();
            }
            if revision == 2 {
                match change {
                    "repository_id" => document["decision"][change] = 1296270.into(),
                    "artifact_hosts" => {
                        document["decision"][change] = serde_json::json!(["github.com"])
                    }
                    "max_redirects" => document["decision"][change] = 4.into(),
                    "grant_id" => document[change] = "managed-github-v1-replacement".into(),
                    "revoked" => document["decision"] = serde_json::json!({"status":"revoked"}),
                    "availability" => {
                        document = availability_for(&targets, ID, revision);
                    }
                    _ => unreachable!(),
                }
            }
            targets.push((
                format!("policy/official/{ID}.json"),
                serde_json::to_vec(&document).unwrap(),
            ));
            assert_eq!(
                fixture
                    .publish_with_policy(
                        &targets,
                        true,
                        &DEFINITION_ROLE_PATHS,
                        later(),
                        Some((&key, revision))
                    )
                    .await,
                root
            );
            let candidate = acquire(&fixture, &root).await.unwrap();
            let admission = acquire_policy(&fixture, &root, ID).await.unwrap();
            if revision == 2 {
                library.connection().unwrap().execute_batch(
                    "CREATE TRIGGER interrupt_continuity BEFORE UPDATE ON definition_publisher_policy
                     BEGIN SELECT RAISE(ABORT,'owned continuity interruption'); END;"
                ).unwrap();
                assert!(
                    library
                        .apply_definition_publisher_policy(&admission, Some(&candidate))
                        .is_err()
                );
                assert!(
                    policy::continues_retained_launch(&library.connection().unwrap(), identity)
                        .unwrap()
                );
                library
                    .connection()
                    .unwrap()
                    .execute_batch("DROP TRIGGER interrupt_continuity")
                    .unwrap();
            }
            library
                .apply_definition_publisher_policy(&admission, Some(&candidate))
                .unwrap();
            assert!(
                !policy::continues_retained_launch(&library.connection().unwrap(), identity)
                    .unwrap(),
                "{change} at {revision}"
            );
            let eligibility = library
                .assess_definition_operation(
                    identity,
                    DefinitionOperationContext::observed(DefinitionOperation::Launch, true, true),
                )
                .unwrap();
            assert_ne!(
                eligibility.outcome,
                DefinitionEligibilityOutcome::Eligible,
                "{change} at {revision}"
            );
            let floor: u64 = library
                .connection()
                .unwrap()
                .query_row(
                    "SELECT retained_launch_revision_floor FROM definition_publisher_admission",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(floor, revision, "{change} at {revision}");
            assert!(
                !library
                    .apply_definition_publisher_policy(&admission, Some(&candidate))
                    .unwrap()
            );
        }
    }
}

#[tokio::test]
async fn retained_launch_refuses_invalid_continuity_and_mismatched_policy() {
    let (_fixture, _key, _root, _directory, library, catalog, _scope) = managed_fixture().await;
    let identity = catalog.definition_selection(ID).unwrap();
    let connection = library.connection().unwrap();
    for floor in [0, 2] {
        connection
            .execute_batch("PRAGMA ignore_check_constraints=ON")
            .unwrap();
        connection
            .execute(
                "UPDATE definition_publisher_admission SET retained_launch_revision_floor=?1",
                [floor],
            )
            .unwrap();
        assert!(policy::continues_retained_launch(&connection, identity).is_err());
    }
    connection
        .execute(
            "UPDATE definition_publisher_admission SET retained_launch_revision_floor=1",
            [],
        )
        .unwrap();
    connection
        .execute(
            "UPDATE definition_publisher_policy SET grant_id='managed-github-v1-other'",
            [],
        )
        .unwrap();
    assert!(policy::continues_retained_launch(&connection, identity).is_err());
    connection
        .execute("DELETE FROM definition_publisher_admission", [])
        .unwrap();
    assert!(!policy::continues_retained_launch(&connection, identity).unwrap());
}

struct WithdrawPreparation {
    library: Library,
    withdrawal: crate::AuthenticatedDefinitionPublisherPolicy,
    point: crate::operation::LifecycleFaultPoint,
    interrupt: bool,
    withdrawals: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}
impl crate::operation::LifecycleFaultInjector for WithdrawPreparation {
    fn check(&self, point: crate::operation::LifecycleFaultPoint) -> crate::Result<()> {
        if point == self.point {
            self.library
                .apply_definition_publisher_policy(&self.withdrawal, None)?;
            self.withdrawals
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if self.interrupt {
                return Err(PortcoveError::state(
                    "owned managed preparation interruption",
                ));
            }
        }
        Ok(())
    }
}

fn managed_preparation_catalog(source_bytes: &[u8]) -> Catalog {
    let (extended, added_id) = post_client_catalog();
    let mut document = extended.authoritative_document();
    let added = document
        .ports
        .iter()
        .find(|port| port.id == added_id)
        .unwrap();
    let profile_id = added.source_profile.clone().unwrap();
    let source_catalog = document.source_catalog.as_mut().unwrap();
    let profile = source_catalog
        .identities
        .iter_mut()
        .find(|profile| profile.id == profile_id)
        .unwrap();
    profile.kind = crate::SourceIdentityKind::File;
    profile.variants = vec![serde_json::from_value(serde_json::json!({
        "id":"owned-raw-source", "title":"Owned synthetic source", "region":null, "revision":null,
        "representations":[{"id":"owned-raw", "kind":"raw-file", "extensions":["z64"],
            "identities":[{"scope":"original-file", "sha256":hex::encode(Sha256::digest(source_bytes)), "sha1":null,"crc32":null}]}]
    })).unwrap()];
    let contract = source_catalog
        .contracts
        .iter_mut()
        .find(|contract| contract.port_id == added_id)
        .unwrap();
    contract.port_id = ID.into();
    contract.admission_mode = crate::CatalogAdmissionMode::Enforced;
    contract.supported_variant_ids = vec!["owned-raw-source".into()];
    contract.validator_contract_id = None;
    contract.applicability.clear();
    document.ports.retain(|port| port.id != added_id);
    let mut port = metadata_catalog().ports()[0].clone();
    let platform = crate::Platform::current().unwrap();
    port.platforms = vec![platform];
    port.source_profile = Some(profile_id);
    port.executable_hints = std::collections::BTreeMap::from([(
        platform,
        vec![if cfg!(windows) {
            "fixture.exe".into()
        } else {
            "fixture".into()
        }],
    )]);
    port.setup_executable_hints = port.executable_hints.clone();
    port.setup_arguments = vec!["--record".into(), "prepared.marker".into()];
    port.setup_marker = Some("prepared.marker".into());
    port.setup_output_paths = vec!["prepared.marker".into()];
    port.runtime_source_filename = Some("source.z64".into());
    port.runtime_source_materialization = Some(crate::RuntimeSourceMaterialization::N64BigEndian);
    document.ports = vec![port];
    // This native consumer fixture needs one exact admitted contract, not the
    // full ordinary discovery transition (covered separately above).
    let source_catalog = document.source_catalog.as_mut().unwrap();
    source_catalog
        .identities
        .retain(|profile| profile.id == document.ports[0].source_profile.as_deref().unwrap());
    source_catalog
        .contracts
        .retain(|contract| contract.port_id == ID);
    source_catalog.validators.clear();
    source_catalog.qualification.clear();
    Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap()
}

fn install_managed_preparation_fixture(
    directory: &TempDir,
    library: &Library,
    catalog: &Catalog,
    source_bytes: &[u8],
) -> (crate::InstallRecord, std::path::PathBuf) {
    let platform = crate::Platform::current().unwrap();
    let port = catalog.port(ID).unwrap();
    let artifact = crate::ArtifactIdentity {
        asset_name: "fixture.zip".into(),
        sha256: hex::encode(Sha256::digest(b"owned source artifact")),
        size: 1,
    };
    let install_root = library.versions_dir().join(ID).join(&artifact.sha256);
    fs::create_dir_all(&install_root).unwrap();
    let probe_root = directory.path().join("owned-probe");
    fs::create_dir(&probe_root).unwrap();
    let executable = install_root.join(&port.executable_hints[&platform][0]);
    fs::copy(crate::test_fixture::build_probe(&probe_root), &executable).unwrap();
    crate::permissions::normalize_archive_entry(&executable, false, true).unwrap();
    let install_id = uuid::Uuid::new_v4().to_string();
    let qualification = crate::InstallQualification::from_catalog(catalog, ID, platform).unwrap();
    let (manifest_sha256, selected_executable, runtime) = crate::Installer::new(library.clone())
        .unwrap()
        .create_manifest(
            &install_id,
            ID,
            "v1",
            &artifact,
            &qualification,
            &install_root,
        )
        .unwrap();
    let original = crate::InstallRecord {
        id: install_id,
        port_id: ID.into(),
        version: "v1".into(),
        path: install_root,
        channel: ReleaseChannel::Stable,
        installed_at: Library::now(),
        verified: true,
        staged: false,
        artifact,
        manifest_sha256,
        selected_executable,
        runtime,
    };
    library.register_install(&original, true).unwrap();
    let source = directory.path().join("source.z64");
    fs::write(&source, source_bytes).unwrap();
    let source_record = crate::source_inspection::inspect(
        catalog,
        port.source_profile.as_deref().unwrap(),
        &source,
    )
    .unwrap()
    .require_admitted_record()
    .unwrap();
    library.register_source(&source_record).unwrap();
    (original, source)
}

async fn assert_managed_preparation_withdrawal(
    point: crate::operation::LifecycleFaultPoint,
    interrupt: bool,
) {
    use crate::operation::{LifecycleFaultPoint, LifecyclePhase, OperationStore};
    let phase_clock = std::time::Instant::now();
    let source_bytes: &[u8] = &[0x80, 0x37, 0x12, 0x40, 0, 0, 0, 0];
    let (fixture, key, root, directory, library, catalog, _scope) =
        managed_fixture_for(managed_preparation_catalog(source_bytes)).await;
    println!(
        "managed preparation {point:?}/{interrupt}: admitted at {:?}",
        phase_clock.elapsed()
    );
    let platform = crate::Platform::current().unwrap();
    let (original, source) =
        install_managed_preparation_fixture(&directory, &library, &catalog, source_bytes);
    let original_tree = crate::library_transfer::reviewed_tree(&original.path).unwrap();
    let mut revoked = managed_github(2);
    revoked["decision"] = serde_json::json!({"status":"revoked"});
    publish(&fixture, &key, 2, &revoked).await;
    let withdrawal = acquire_policy(&fixture, &root, ID).await.unwrap();
    let withdrawals = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let mut service = PortcoveService::with_faults(
        library.clone(),
        std::sync::Arc::new(WithdrawPreparation {
            library: library.clone(),
            withdrawal,
            point,
            interrupt,
            withdrawals: withdrawals.clone(),
        }),
    )
    .unwrap();
    service.replace_catalog_for_test(catalog.clone());
    let options = crate::PreparationOptions {
        target: platform,
        mode: crate::PreparationMode::Default,
    };
    let plan = service.plan_preparation(ID, options).unwrap();
    let authorization = service
        .authorize_preparation(ID, options, &plan.plan_sha256)
        .unwrap();
    assert!(
        service
            .prepare(ID, options, &authorization.token, |_| {})
            .is_err()
    );
    assert_eq!(
        withdrawals.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "the exact preparation checkpoint must apply withdrawal"
    );
    println!(
        "managed preparation {point:?}/{interrupt}: returned at {:?}",
        phase_clock.elapsed()
    );
    let store = OperationStore::new(library.clone());
    let before = store.all().unwrap().remove(0);
    assert_eq!(count(&library, "installs"), 1);
    assert_eq!(service.status(ID).unwrap().active.unwrap().id, original.id);
    let retained_tree =
        crate::library_transfer::reviewed_tree(before.paths.staging.as_ref().unwrap()).unwrap();
    let expected_phase = if point == LifecycleFaultPoint::PreparationPublished {
        LifecyclePhase::PayloadPublished
    } else if interrupt && point == LifecycleFaultPoint::PreparationOutputsValidated {
        LifecyclePhase::Preparing
    } else {
        LifecyclePhase::Prepared
    };
    assert_eq!(before.phase, expected_phase);
    drop(service);
    for _ in 0..2 {
        let reopened = PortcoveService::new(library.clone()).unwrap();
        // Service construction already performs real startup recovery.
        println!(
            "managed preparation {point:?}/{interrupt}: startup at {:?}",
            phase_clock.elapsed()
        );
        let after = store.get(&before.id).unwrap().unwrap();
        assert_eq!(after.phase, before.phase);
        assert_eq!(count(&library, "installs"), 1);
        assert_eq!(reopened.status(ID).unwrap().active.unwrap().id, original.id);
        assert_eq!(
            crate::library_transfer::reviewed_tree(before.paths.staging.as_ref().unwrap()).unwrap(),
            retained_tree
        );
        assert_eq!(
            crate::library_transfer::reviewed_tree(&original.path).unwrap(),
            original_tree
        );
        assert_eq!(fs::read(&source).unwrap(), source_bytes);
    }
}

macro_rules! managed_preparation_cases {
    ($($name:ident: $point:ident, $interrupt:literal),+ $(,)?) => {
        $(#[tokio::test] async fn $name() {
            assert_managed_preparation_withdrawal(crate::operation::LifecycleFaultPoint::$point, $interrupt).await;
        })+
    };
}
managed_preparation_cases! {
    managed_preparation_outputs_validation_refuses_withdrawal: PreparationOutputsValidated, false,
    managed_preparation_outputs_validation_interruption_retains_private_work: PreparationOutputsValidated, true,
    managed_preparation_prepared_refuses_withdrawal: PreparationPrepared, false,
    managed_preparation_prepared_interruption_survives_restart: PreparationPrepared, true,
    managed_preparation_published_refuses_withdrawal: PreparationPublished, false,
    managed_preparation_published_interruption_survives_restart: PreparationPublished, true,
}

#[tokio::test]
async fn managed_policy_expiry_keeps_verified_public_launch_and_holds_fresh_acquisition() {
    let source_bytes: &[u8] = &[0x80, 0x37, 0x12, 0x40, 0, 0, 0, 0];
    let (_fixture, _key, _root, directory, library, catalog, scope) =
        managed_fixture_for(managed_preparation_catalog(source_bytes)).await;
    let (_original, source) =
        install_managed_preparation_fixture(&directory, &library, &catalog, source_bytes);
    let mut current = PortcoveService::new(library.clone()).unwrap();
    current.replace_catalog_for_test(catalog.clone());
    let options = crate::PreparationOptions {
        target: crate::Platform::current().unwrap(),
        mode: crate::PreparationMode::Default,
    };
    let plan = current.plan_preparation(ID, options).unwrap();
    let authorization = current
        .authorize_preparation(ID, options, &plan.plan_sha256)
        .unwrap();
    let prepared = current
        .prepare(ID, options, &authorization.token, |_| {})
        .unwrap();
    // Normal successful launch records this marker; include that expected
    // mutation while requiring every other retained payload byte to survive.
    fs::write(prepared.path.join(".portcove-launched"), b"1").unwrap();
    let prepared_tree = crate::library_transfer::reviewed_tree(&prepared.path).unwrap();
    // Simulate elapsed publisher metadata time without changing the admitted
    // signed policy bytes, retained manifest, role identity, or replay floor.
    let connection = library.connection().unwrap();
    let encoded: String = connection
        .query_row(
            "SELECT provenance_json FROM definition_publisher_admission",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let mut provenance: Value = serde_json::from_str(&encoded).unwrap();
    provenance["expires_at"] = "2000-01-01T00:00:00Z".into();
    connection
        .execute(
            "UPDATE definition_publisher_admission SET provenance_json=?1",
            [provenance.to_string()],
        )
        .unwrap();
    assert!(scope.require_current().is_err());
    for (index, service) in [current, PortcoveService::new(library.clone()).unwrap()]
        .into_iter()
        .enumerate()
    {
        let status = service.status(ID).unwrap();
        assert_eq!(status.active.as_ref().unwrap().id, prepared.id);
        let install = status
            .definition_operations
            .iter()
            .find(|assessment| assessment.operation == DefinitionOperation::Install)
            .unwrap();
        assert_eq!(
            install.eligibility.reason,
            DefinitionEligibilityReason::MetadataStale
        );
        let launch = status
            .definition_operations
            .iter()
            .find(|assessment| assessment.operation == DefinitionOperation::Launch)
            .unwrap();
        assert_eq!(
            launch.eligibility.outcome,
            DefinitionEligibilityOutcome::Eligible
        );
        let mut started = 0;
        // An immediately exiting probe may return successfully before macOS
        // can record a running identity. Use the existing bounded handshake
        // so this assertion exercises the durable running callback itself.
        let release = directory.path().join(format!("launch-release-{index}"));
        let outcome = service
            .supervise_launch(
                ID,
                None,
                &[
                    "--game".into(),
                    "--owned-wait".into(),
                    release.to_string_lossy().into_owned(),
                ],
                crate::LaunchStdio::Null,
                |_| {
                    started += 1;
                    fs::write(&release, b"released").unwrap();
                },
            )
            .unwrap();
        assert!(outcome.successful);
        assert_eq!(outcome.exit_code, Some(0));
        assert_eq!(started, 1);
    }
    assert_eq!(fs::read(&source).unwrap(), source_bytes);
    assert_eq!(
        crate::library_transfer::reviewed_tree(&prepared.path).unwrap(),
        prepared_tree
    );
    connection
        .execute(
            "UPDATE definition_publisher_authority SET replay_floor_json=NULL",
            [],
        )
        .unwrap();
    let untrusted = PortcoveService::new(library.clone()).unwrap();
    let mut started = 0;
    assert!(
        untrusted
            .supervise_launch(
                ID,
                None,
                &["--success".into()],
                crate::LaunchStdio::Null,
                |_| started += 1
            )
            .is_err()
    );
    assert_eq!(started, 0);
}
