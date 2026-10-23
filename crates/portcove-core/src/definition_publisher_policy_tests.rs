use super::super::publisher_policy as policy;
use super::*;
use crate::{PortcoveError, ReleaseChannel};

const ID: &str = "tuf-metadata-fixture";

#[path = "definition_launch_assessment_tests.rs"]
mod launch_assessments;

#[path = "definition_authority_tests.rs"]
mod authority_provisioning;

#[path = "definition_refresh_tests.rs"]
mod ordinary_refresh;

#[cfg(feature = "qualification-fixtures")]
#[path = "definition_compiled_client_tests.rs"]
mod compiled_clients;

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

pub(super) fn availability_for(targets: &[(String, Vec<u8>)], id: &str, revision: u64) -> Value {
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
    // Provider and policy-storage cases need one exact authenticated definition.
    // The ordinary lifecycle fixture separately proves loading a newly selected
    // definition through the complete, unchanged embedded baseline.
    managed_fixture_for(metadata_catalog()).await
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
    let mut document = managed_policy_for(&targets, launch_checks);
    if launch_checks && !authored.port(ID).unwrap().release.curated.is_empty() {
        document["policy_schema"] = 4.into();
        document["decision"]["curated_acquisition_checks"] = 1.into();
    }
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
    managed_policy_for_id(targets, launch_checks, ID)
}

fn managed_policy_for_id(targets: &[(String, Vec<u8>)], launch_checks: bool, id: &str) -> Value {
    let mut document = availability_for(targets, id, 1);
    let managed = managed_github(1);
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
        document["decision"][field] = managed["decision"][field].clone();
    }
    document
}

fn curated_metadata_document() -> crate::CatalogDocument {
    let mut document = metadata_catalog().authoritative_document();
    // Curated authority requires schema 2; this synthetic port owns no source
    // profiles, so its complete source graph is deliberately empty.
    document.schema_version = 2;
    document.source_catalog = Some(crate::SourceCatalog {
        evidence: Vec::new(),
        identities: Vec::new(),
        contracts: Vec::new(),
        validators: Vec::new(),
        qualification: Vec::new(),
    });
    document
}

#[tokio::test]
async fn curated_capability_preserves_other_platform_publisher_digest_installation() {
    use crate::ReleaseProvider;
    use std::io::{Cursor, Write};
    let platform = crate::Platform::current().unwrap();
    let other = if platform == crate::Platform::WindowsX86_64 {
        crate::Platform::LinuxX86_64
    } else {
        crate::Platform::WindowsX86_64
    };
    let executable = if cfg!(windows) {
        "fixture.exe"
    } else {
        "fixture"
    };
    let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
    archive
        .start_file(
            executable,
            zip::write::SimpleFileOptions::default().unix_permissions(0o755),
        )
        .unwrap();
    archive
        .write_all(b"Owned nonexecuted publisher-digest platform fixture")
        .unwrap();
    let bytes = archive.finish().unwrap().into_inner();
    let digest = hex::encode(Sha256::digest(&bytes));
    let mut baseline = curated_metadata_document();
    let mut port = metadata_catalog().ports()[0].clone();
    port.platforms = vec![platform, other];
    port.executable_hints = std::collections::BTreeMap::from([
        (platform, vec![executable.into()]),
        (
            other,
            vec![if other == crate::Platform::WindowsX86_64 {
                "fixture.exe".into()
            } else {
                "fixture".into()
            }],
        ),
    ]);
    let mut record = crate::curated_acquisition::fixture_record();
    record.repository = port.release.repository.clone();
    record.upstream_url = format!("https://github.com/{}", record.repository);
    record.platform = other;
    record.filename = format!("game-{}.zip", other.asset_tokens()[0]);
    record.acquisition_url = format!(
        "{}/releases/download/{}/{}",
        record.upstream_url, record.tag, record.filename
    );
    port.release.curated.insert(other, record);
    baseline.ports[0] = port;
    let authored = Catalog::from_json(&serde_json::to_string(&baseline).unwrap()).unwrap();
    let (_fixture, _key, _root, _directory, library, catalog, mut scope) =
        managed_fixture_for_policy(authored, true).await;
    assert_eq!(scope.curated_checks, Some(1));
    let server = AcquisitionHttp::new();
    scope.fixture_origin = Some(server.origin.clone());
    let provider = crate::GithubReleaseProvider::with_api_root(server.origin.clone()).unwrap();
    let mut release = server.release(true);
    release[0]["assets"][0]["name"] = format!("game-{}.zip", platform.asset_tokens()[0]).into();
    release[0]["assets"][0]["size"] = bytes.len().into();
    release[0]["assets"][0]["digest"] = format!("sha256:{digest}").into();
    server.json(serde_json::json!({"id":scope.repository_id,"archived":false}));
    server.json(release.clone());
    let resolution = provider
        .resolve_scoped(
            catalog.port(ID).unwrap(),
            ReleaseChannel::Stable,
            platform,
            Some(&scope),
        )
        .await
        .unwrap();
    server.json(serde_json::json!({"id":scope.repository_id,"archived":false}));
    server.json(release);
    server.bytes(&bytes);
    let installer = crate::Installer::new(library.clone()).unwrap();
    let request = crate::InstallRequest {
        port_id: ID.into(),
        release: resolution.release.clone(),
        output_root: library.versions_dir().join(ID),
        activate: false,
        managed: None,
        qualification: crate::InstallQualification::from_catalog(&catalog, ID, platform)
            .unwrap()
            .with_acquisition_resolution(resolution)
            .unwrap(),
    };
    let installed = installer
        .install(
            request,
            &crate::operation::OperationCoordinator::new("install", None),
            |_| {},
        )
        .await
        .unwrap();
    assert_eq!(installed.artifact.sha256, digest);
    assert!(installer.verify(&installed).unwrap().valid);
    assert_eq!(server.requests.lock().unwrap().len(), 5);
    assert!(
        !library.downloads_dir().join("curated-v1").exists(),
        "publisher-digest platform must not enter the curated cache"
    );
}

async fn curated_transition_fixture() -> (
    RepositoryFixture,
    Key,
    Vec<u8>,
    TempDir,
    Library,
    Catalog,
    crate::CuratedAcquisitionRecord,
    crate::CuratedAcquisitionRecord,
) {
    // These cases exercise signed admission, exact scope history and SQLite
    // persistence without service startup or unrelated production port facts.
    let mut baseline = curated_metadata_document();
    let mut port = metadata_catalog().ports()[0].clone();
    port.platforms = vec![crate::Platform::WindowsX86_64, crate::Platform::LinuxX86_64];
    port.executable_hints = std::collections::BTreeMap::from([
        (crate::Platform::WindowsX86_64, vec!["fixture.exe".into()]),
        (crate::Platform::LinuxX86_64, vec!["fixture".into()]),
    ]);
    let mut affected = crate::curated_acquisition::fixture_record();
    affected.repository = port.release.repository.clone();
    affected.upstream_url = format!("https://github.com/{}", affected.repository);
    affected.filename = "game-windows.zip".into();
    affected.acquisition_url = format!(
        "{}/releases/download/{}/{}",
        affected.upstream_url, affected.tag, affected.filename
    );
    let mut unaffected = affected.clone();
    unaffected.asset_id += 1;
    unaffected.platform = crate::Platform::LinuxX86_64;
    unaffected.filename = "game-linux.zip".into();
    unaffected.sha256 = "d".repeat(64);
    unaffected.acquisition_url = format!(
        "{}/releases/download/{}/{}",
        unaffected.upstream_url, unaffected.tag, unaffected.filename
    );
    port.release.curated = std::collections::BTreeMap::from([
        (affected.platform, affected.clone()),
        (unaffected.platform, unaffected.clone()),
    ]);
    baseline.ports[0] = port;
    let authored = Catalog::from_json(&serde_json::to_string(&baseline).unwrap()).unwrap();
    let (fixture, key, root, directory, library, catalog, _) =
        managed_fixture_for_policy(authored, true).await;
    (
        fixture, key, root, directory, library, catalog, affected, unaffected,
    )
}

async fn publish_curated_transition(
    fixture: &RepositoryFixture,
    key: &Key,
    root: &[u8],
    catalog: &Catalog,
    revision: u64,
    transitions: Option<Value>,
) -> (
    crate::AuthenticatedDefinitionCandidate,
    crate::AuthenticatedDefinitionPublisherPolicy,
) {
    publish_curated_transition_for_id(fixture, key, root, catalog, revision, transitions, ID).await
}

async fn publish_curated_transition_for_id(
    fixture: &RepositoryFixture,
    key: &Key,
    root: &[u8],
    catalog: &Catalog,
    revision: u64,
    transitions: Option<Value>,
    id: &str,
) -> (
    crate::AuthenticatedDefinitionCandidate,
    crate::AuthenticatedDefinitionPublisherPolicy,
) {
    let definition_revision = catalog
        .definition_selection(id)
        .map_or(7, |identity| identity.definition_revision);
    let bundle =
        crate::test_fixture::indexed_catalog_bundle_at_revision(catalog, id, definition_revision);
    let mut targets = vec![(INDEX_TARGET.to_owned(), bundle.index)];
    targets.extend(bundle.contents);
    let mut document = managed_policy_for_id(&targets, true, id);
    document["policy_schema"] = 4.into();
    document["policy_revision"] = revision.into();
    document["decision"]["curated_acquisition_checks"] = 1.into();
    if let Some(transitions) = transitions {
        document["curated_transitions"] = transitions;
    }
    targets.push((
        format!("policy/official/{id}.json"),
        serde_json::to_vec(&document).unwrap(),
    ));
    fixture
        .publish_with_policy(
            &targets,
            true,
            &DEFINITION_ROLE_PATHS,
            later(),
            Some((key, revision)),
        )
        .await;
    (
        acquire(fixture, root).await.unwrap(),
        acquire_policy(fixture, root, id).await.unwrap(),
    )
}

fn curated_other_scope_catalog(
    catalog: &Catalog,
    record: &crate::CuratedAcquisitionRecord,
) -> Catalog {
    let mut document = catalog.authoritative_document();
    let mut other = catalog.port(ID).unwrap().clone();
    other.id = "curated-other-scope".into();
    other.release.curated = std::collections::BTreeMap::from([(record.platform, record.clone())]);
    document.ports.push(other);
    Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap()
}

#[tokio::test]
async fn curated_other_scope_cannot_transition_or_accept_another_ports_history() {
    let (fixture, key, root, _directory, library, catalog, affected, unaffected) =
        curated_transition_fixture().await;
    let other = curated_other_scope_catalog(&catalog, &unaffected);
    let transition = serde_json::json!({"future_acceptance_lost":false, "artifacts":[
        {"asset_id":affected.asset_id,"sha256":affected.sha256,"status":"revoked"}]});
    let (candidate, admission) = publish_curated_transition_for_id(
        &fixture,
        &key,
        &root,
        &other,
        2,
        Some(transition),
        "curated-other-scope",
    )
    .await;
    let refusal = library
        .apply_definition_publisher_policy(&admission, Some(&candidate))
        .unwrap_err();
    assert!(refusal.message.contains("authority scope"));
    assert_eq!(count(&library, "curated_transition_receipts"), 0);
    assert_eq!(count(&library, "curated_artifact_scopes"), 2);
    // The hash is globally accepted, but this port has never admitted it.
    let transition = serde_json::json!({"future_acceptance_lost":true, "artifacts":[]});
    let (candidate, admission) = publish_curated_transition_for_id(
        &fixture,
        &key,
        &root,
        &other,
        3,
        Some(transition),
        "curated-other-scope",
    )
    .await;
    assert!(
        library
            .apply_definition_publisher_policy(&admission, Some(&candidate))
            .unwrap_err()
            .message
            .contains("authority scope")
    );
    assert_eq!(count(&library, "curated_transition_receipts"), 0);
    assert_eq!(count(&library, "curated_artifact_scopes"), 2);
    let (candidate, admission) = publish_curated_transition_for_id(
        &fixture,
        &key,
        &root,
        &other,
        4,
        None,
        "curated-other-scope",
    )
    .await;
    library
        .apply_definition_publisher_policy(&admission, Some(&candidate))
        .unwrap();
    let repository = policy::acquisition_scope(&library, &catalog, ID)
        .unwrap()
        .unwrap()
        .repository_id;
    for record in [&affected, &unaffected] {
        policy::require_curated_artifact_operation(
            &library.connection().unwrap(),
            repository,
            record,
            policy::CuratedArtifactOperation::LocalUse,
        )
        .unwrap();
    }
    assert_eq!(count(&library, "curated_artifact_admissions"), 2);
    assert_eq!(count(&library, "curated_artifact_scopes"), 3);
    assert_eq!(count(&library, "installs"), 0);
    // Lost membership evidence cannot be silently restored by exact renewal.
    library
        .connection()
        .unwrap()
        .execute(
            "DELETE FROM curated_artifact_scopes WHERE stable_id='curated-other-scope'",
            [],
        )
        .unwrap();
    assert_eq!(count(&library, "curated_artifact_scopes"), 2);
    assert!(
        library
            .apply_definition_publisher_policy(&admission, Some(&candidate))
            .unwrap_err()
            .message
            .contains("scope history is incomplete")
    );
    assert!(
        policy::require_curated_artifact_operation(
            &library.connection().unwrap(),
            repository,
            &unaffected,
            policy::CuratedArtifactOperation::LocalUse
        )
        .unwrap_err()
        .message
        .contains("scope history is incomplete")
    );
    assert_eq!(count(&library, "curated_artifact_scopes"), 2);
    assert_eq!(count(&library, "curated_artifact_admissions"), 2);
}

#[tokio::test]
async fn curated_shared_artifact_clearance_preserves_other_scope_and_omitted_history() {
    let (fixture, key, root, _directory, library, catalog, affected, unaffected) =
        curated_transition_fixture().await;
    let other = curated_other_scope_catalog(&catalog, &affected);
    let (candidate, admission) = publish_curated_transition_for_id(
        &fixture,
        &key,
        &root,
        &other,
        2,
        None,
        "curated-other-scope",
    )
    .await;
    library
        .apply_definition_publisher_policy(&admission, Some(&candidate))
        .unwrap();
    let repository = policy::acquisition_scope(&library, &catalog, ID)
        .unwrap()
        .unwrap()
        .repository_id;
    let omitted = curated_other_scope_catalog(&catalog, &unaffected);
    for (revision, id, document, status, held) in [
        (3, ID, &catalog, "revoked", true),
        (4, "curated-other-scope", &omitted, "revoked", true),
        (5, ID, &catalog, "cleared", true),
        (6, "curated-other-scope", &omitted, "cleared", false),
    ] {
        let transition = serde_json::json!({"future_acceptance_lost":false,"artifacts":[
            {"asset_id":affected.asset_id,"sha256":affected.sha256,"status":status}]});
        let (candidate, admission) = publish_curated_transition_for_id(
            &fixture,
            &key,
            &root,
            document,
            revision,
            Some(transition),
            id,
        )
        .await;
        library
            .apply_definition_publisher_policy(&admission, Some(&candidate))
            .unwrap();
        for operation in [
            policy::CuratedArtifactOperation::Acquisition,
            policy::CuratedArtifactOperation::LocalUse,
        ] {
            let result = policy::require_curated_artifact_operation(
                &library.connection().unwrap(),
                repository,
                &affected,
                operation,
            );
            if held {
                assert!(result.unwrap_err().message.contains("revoked"));
            } else {
                result.unwrap();
            }
            policy::require_curated_artifact_operation(
                &library.connection().unwrap(),
                repository,
                &unaffected,
                operation,
            )
            .unwrap();
        }
    }
    assert_eq!(count(&library, "curated_artifact_admissions"), 2);
    assert_eq!(count(&library, "curated_artifact_scopes"), 4);
    assert_eq!(count(&library, "curated_transition_receipts"), 4);
    assert_eq!(count(&library, "installs"), 0);
}

#[tokio::test]
async fn curated_distribution_withdrawal_survives_renewal_without_revoking_local_use() {
    let (fixture, key, root, _directory, library, catalog, affected, unaffected) =
        curated_transition_fixture().await;
    let repository_id = crate::curated_acquisition::repository_for_retained_record(
        &library.connection().unwrap(),
        &affected,
    )
    .unwrap();
    let transitions = serde_json::json!({"future_acceptance_lost":false, "artifacts":[{"asset_id":affected.asset_id,"sha256":affected.sha256,"status":"distribution_withdrawn"}]});
    let (candidate, policy) =
        publish_curated_transition(&fixture, &key, &root, &catalog, 2, Some(transitions)).await;
    library
        .apply_definition_publisher_policy(&policy, Some(&candidate))
        .unwrap();
    let (candidate, policy) =
        publish_curated_transition(&fixture, &key, &root, &catalog, 3, None).await;
    library
        .apply_definition_publisher_policy(&policy, Some(&candidate))
        .unwrap();
    let library_root = library.root().to_owned();
    drop(library);
    let library = Library::open(library_root).unwrap();
    assert_eq!(count(&library, "curated_transition_receipts"), 1);
    let connection = library.connection().unwrap();
    let (known_repository, known_hash) = crate::curated_acquisition::known_download_identity(
        &connection,
        affected.asset_id,
        affected.release_id,
        &affected.acquisition_url,
        affected.size,
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        policy::assess_known_artifact_operation(
            &connection,
            known_repository,
            affected.asset_id,
            &known_hash,
            policy::CuratedArtifactOperation::Acquisition
        )
        .unwrap()
        .reason,
        crate::DefinitionEligibilityReason::CuratedDistributionWithdrawn
    );
    assert!(
        policy::require_curated_artifact_operation(
            &connection,
            repository_id,
            &affected,
            policy::CuratedArtifactOperation::Acquisition
        )
        .unwrap_err()
        .message
        .contains("distribution")
    );
    policy::require_curated_artifact_operation(
        &connection,
        repository_id,
        &affected,
        policy::CuratedArtifactOperation::LocalUse,
    )
    .unwrap();
    for operation in [
        policy::CuratedArtifactOperation::Acquisition,
        policy::CuratedArtifactOperation::LocalUse,
    ] {
        policy::require_curated_artifact_operation(
            &connection,
            repository_id,
            &unaffected,
            operation,
        )
        .unwrap();
    }
    assert_eq!(count(&library, "curated_artifact_admissions"), 2);
}

#[tokio::test]
async fn curated_metadata_tag_peeling_enforces_exact_identity_and_finite_bound() {
    use crate::ReleaseProvider;
    let (_fixture, _key, _root, _directory, library, catalog, record, _) =
        curated_transition_fixture().await;
    let mut scope = policy::acquisition_scope(&library, &catalog, ID)
        .unwrap()
        .unwrap();
    let server = AcquisitionHttp::new();
    scope.fixture_origin = Some(server.origin.clone());
    let provider = crate::GithubReleaseProvider::with_api_root_and_library(
        server.origin.clone(),
        library.clone(),
    )
    .unwrap();
    let path = reqwest::Url::parse(&record.acquisition_url)
        .unwrap()
        .path()
        .to_owned();
    let release = serde_json::json!([{
        "id":record.release_id,"tag_name":record.tag,"draft":false,"prerelease":false,"published_at":null,
        "assets":[{"id":record.asset_id,"name":record.filename,"size":record.size,"digest":null,
        "browser_download_url":format!("{}{path}", server.origin)}]
    }]);
    let object = |kind: &str, sha: &str| serde_json::json!({"type":kind,"sha":sha});
    let reference = |kind: &str, sha: &str| serde_json::json!({"ref":format!("refs/tags/{}",record.tag),"object":object(kind,sha)});
    let mut cases = vec![(
        "lightweight",
        reference("commit", &record.commit_sha1),
        Vec::new(),
        None,
    )];
    for depth in [1usize, 4, 5] {
        let ids: Vec<_> = (0..depth)
            .map(|index| char::from(b'b' + index as u8).to_string().repeat(40))
            .collect();
        let annotations = ids.iter().enumerate().map(|(index, sha)| serde_json::json!({
            "sha":sha,"object":if index + 1 == depth {object("commit", &record.commit_sha1)} else {object("tag", &ids[index+1])}
        })).collect();
        cases.push((
            match depth {
                1 => "annotated",
                4 => "maximum-permitted-chain",
                _ => "over-bound-chain",
            },
            reference("tag", &ids[0]),
            annotations,
            (depth == 5).then_some("exceeds its peel bound"),
        ));
    }
    let tag_id = "b".repeat(40);
    cases.push(("mismatched-object", reference("tag", &tag_id), vec![serde_json::json!({"sha":"c".repeat(40),"object":object("commit", &record.commit_sha1)})], Some("annotated tag identity differs")));
    cases.push((
        "cycle",
        reference("tag", &tag_id),
        vec![serde_json::json!({"sha":tag_id,"object":object("tag", &tag_id)})],
        Some("invalid or cyclic curated tag object"),
    ));
    cases.push((
        "non-commit-object",
        reference("blob", &tag_id),
        vec![],
        Some("does not identify a commit"),
    ));
    cases.push((
        "malformed-object",
        reference("commit", &"A".repeat(40)),
        vec![],
        Some("invalid or cyclic curated tag object"),
    ));
    let mut wrong_reference = reference("commit", &record.commit_sha1);
    wrong_reference["ref"] = "refs/tags/other".into();
    cases.push((
        "mismatched-reference",
        wrong_reference,
        vec![],
        Some("tag reference differs"),
    ));
    let admission_count = count(&library, "curated_artifact_admissions");
    for (name, tag_reference, annotations, failure) in cases {
        let before = server.requests.lock().unwrap().len();
        server.json(serde_json::json!({"id":scope.repository_id,"archived":false}));
        server.json(release.clone());
        server.json(tag_reference);
        let annotation_count = annotations.len();
        for annotation in annotations {
            server.json(annotation);
        }
        let resolved = provider
            .resolve_scoped(
                catalog.port(ID).unwrap(),
                ReleaseChannel::Stable,
                record.platform,
                Some(&scope),
            )
            .await;
        if let Some(message) = failure {
            let error = resolved.unwrap_err();
            assert_eq!(
                error.code,
                crate::ErrorCode::Verification,
                "{name}: {error:?}"
            );
            assert!(error.message.contains(message), "{name}: {error:?}");
        } else {
            let resolved = resolved.unwrap();
            assert_eq!(resolved.release.asset.sha256, record.sha256, "{name}");
            assert_eq!(resolved.release.asset.size, record.size, "{name}");
        }
        let requests = server.requests.lock().unwrap();
        assert_eq!(
            requests.len(),
            before + 3 + annotation_count,
            "{name}: fresh bounded metadata only"
        );
        assert!(
            requests[before + 2].starts_with(&format!(
                "GET /repos/{}/git/ref/tags/{} ",
                record.repository, record.tag
            )),
            "{name}"
        );
        assert!(
            requests[before..]
                .iter()
                .all(|request| !request.starts_with(&format!("GET {path} "))),
            "{name}: no payload acquisition"
        );
        drop(requests);
        assert!(server.responses.lock().unwrap().is_empty(), "{name}");
        assert_eq!(
            count(&library, "curated_artifact_admissions"),
            admission_count
        );
        assert_eq!(count(&library, "curated_transition_receipts"), 0);
        assert_eq!(count(&library, "installs"), 0);
        assert!(
            crate::operation::OperationStore::new(library.clone())
                .all()
                .unwrap()
                .is_empty()
        );
    }
    // Scoped metadata never follows a redirect, including between two owned
    // loopback endpoints. No credential or payload can reach the second host.
    let redirect_target = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    redirect_target.set_nonblocking(true).unwrap();
    let before = server.requests.lock().unwrap().len();
    server.json(serde_json::json!({"id":scope.repository_id,"archived":false}));
    server.json(release);
    server.redirect(&format!(
        "http://{}/redirected-tag",
        redirect_target.local_addr().unwrap()
    ));
    assert!(
        provider
            .resolve_scoped(
                catalog.port(ID).unwrap(),
                ReleaseChannel::Stable,
                record.platform,
                Some(&scope)
            )
            .await
            .is_err()
    );
    assert_eq!(server.requests.lock().unwrap().len(), before + 3);
    assert_eq!(
        redirect_target.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    assert!(server.responses.lock().unwrap().is_empty());
    assert_eq!(
        count(&library, "curated_artifact_admissions"),
        admission_count
    );
    assert_eq!(count(&library, "installs"), 0);
}

#[tokio::test]
async fn curated_artifact_revocation_is_exact_and_missing_receipts_cannot_be_renewed() {
    let (fixture, key, root, _directory, library, catalog, affected, unaffected) =
        curated_transition_fixture().await;
    let repository_id = crate::curated_acquisition::repository_for_retained_record(
        &library.connection().unwrap(),
        &affected,
    )
    .unwrap();
    let transitions = serde_json::json!({"future_acceptance_lost":false, "artifacts":[{"asset_id":affected.asset_id,"sha256":affected.sha256,"status":"revoked"}]});
    let (candidate, admission) =
        publish_curated_transition(&fixture, &key, &root, &catalog, 2, Some(transitions)).await;
    library
        .apply_definition_publisher_policy(&admission, Some(&candidate))
        .unwrap();
    let connection = library.connection().unwrap();
    let (known_repository, known_hash) = crate::curated_acquisition::known_download_identity(
        &connection,
        affected.asset_id,
        affected.release_id,
        &affected.acquisition_url,
        affected.size,
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        policy::assess_known_artifact_operation(
            &connection,
            known_repository,
            affected.asset_id,
            &known_hash,
            policy::CuratedArtifactOperation::Acquisition
        )
        .unwrap()
        .reason,
        crate::DefinitionEligibilityReason::CuratedArtifactRevoked
    );
    for operation in [
        policy::CuratedArtifactOperation::Acquisition,
        policy::CuratedArtifactOperation::LocalUse,
    ] {
        assert!(
            policy::require_curated_artifact_operation(
                &library.connection().unwrap(),
                repository_id,
                &affected,
                operation
            )
            .unwrap_err()
            .message
            .contains("revoked")
        );
        policy::require_curated_artifact_operation(
            &library.connection().unwrap(),
            repository_id,
            &unaffected,
            operation,
        )
        .unwrap();
    }
    library
        .connection()
        .unwrap()
        .execute("DELETE FROM curated_transition_receipts", [])
        .unwrap();
    assert!(
        policy::require_curated_artifact_operation(
            &library.connection().unwrap(),
            repository_id,
            &affected,
            policy::CuratedArtifactOperation::LocalUse
        )
        .is_err()
    );
    assert!(
        library
            .apply_definition_publisher_policy(&admission, Some(&candidate))
            .unwrap_err()
            .message
            .contains("transition history")
    );
    assert_eq!(count(&library, "curated_transition_receipts"), 0);
    assert_eq!(count(&library, "curated_artifact_admissions"), 2);
}

#[tokio::test]
async fn curated_artifact_hold_survives_expiry_and_requires_explicit_scoped_clearance() {
    let (fixture, key, root, _directory, library, catalog, affected, unaffected) =
        curated_transition_fixture().await;
    let repository_id = crate::curated_acquisition::repository_for_retained_record(
        &library.connection().unwrap(),
        &affected,
    )
    .unwrap();
    let transitions = serde_json::json!({"future_acceptance_lost":false, "artifacts":[
        {"asset_id":affected.asset_id,"sha256":affected.sha256,"status":"revoked"}]});
    let (candidate, admission) =
        publish_curated_transition(&fixture, &key, &root, &catalog, 2, Some(transitions)).await;
    library
        .apply_definition_publisher_policy(&admission, Some(&candidate))
        .unwrap();
    let connection = library.connection().unwrap();
    let encoded: String = connection
        .query_row(
            "SELECT provenance_json FROM curated_transition_receipts",
            [],
            |row| row.get(0),
        )
        .unwrap();
    // Elapsed-time simulation changes only the owned fixture's receipt expiry.
    let mut provenance: Value = serde_json::from_str(&encoded).unwrap();
    provenance["expires_at"] = "2000-01-01T00:00:00Z".into();
    connection
        .execute(
            "UPDATE curated_transition_receipts SET provenance_json=?1",
            [provenance.to_string()],
        )
        .unwrap();
    for operation in [
        policy::CuratedArtifactOperation::Acquisition,
        policy::CuratedArtifactOperation::LocalUse,
    ] {
        assert!(
            policy::require_curated_artifact_operation(
                &connection,
                repository_id,
                &affected,
                operation
            )
            .unwrap_err()
            .message
            .contains("revoked")
        );
        policy::require_curated_artifact_operation(
            &connection,
            repository_id,
            &unaffected,
            operation,
        )
        .unwrap();
    }
    let transitions = serde_json::json!({"future_acceptance_lost":false, "artifacts":[
        {"asset_id":affected.asset_id,"sha256":affected.sha256,"status":"cleared"}]});
    let (candidate, admission) =
        publish_curated_transition(&fixture, &key, &root, &catalog, 3, Some(transitions)).await;
    library
        .apply_definition_publisher_policy(&admission, Some(&candidate))
        .unwrap();
    for operation in [
        policy::CuratedArtifactOperation::Acquisition,
        policy::CuratedArtifactOperation::LocalUse,
    ] {
        policy::require_curated_artifact_operation(
            &connection,
            repository_id,
            &affected,
            operation,
        )
        .unwrap();
    }
    assert_eq!(count(&library, "curated_transition_receipts"), 2);
    assert_eq!(count(&library, "curated_artifact_admissions"), 2);
}

#[tokio::test]
async fn curated_future_acceptance_loss_preserves_old_records_but_refuses_new_identity() {
    let (fixture, key, root, _directory, library, catalog, affected, _) =
        curated_transition_fixture().await;
    let (candidate, policy) = publish_curated_transition(
        &fixture,
        &key,
        &root,
        &catalog,
        2,
        Some(serde_json::json!({"future_acceptance_lost":true,"artifacts":[]})),
    )
    .await;
    library
        .apply_definition_publisher_policy(&policy, Some(&candidate))
        .unwrap();
    let repository_id = crate::curated_acquisition::repository_for_retained_record(
        &library.connection().unwrap(),
        &affected,
    )
    .unwrap();
    for operation in [
        policy::CuratedArtifactOperation::Acquisition,
        policy::CuratedArtifactOperation::LocalUse,
    ] {
        policy::require_curated_artifact_operation(
            &library.connection().unwrap(),
            repository_id,
            &affected,
            operation,
        )
        .unwrap();
    }
    let mut new = catalog.authoritative_document();
    let record = new
        .ports
        .iter_mut()
        .find(|port| port.id == ID)
        .unwrap()
        .release
        .curated
        .get_mut(&affected.platform)
        .unwrap();
    record.asset_id += 10;
    let new = Catalog::from_json(&serde_json::to_string(&new).unwrap()).unwrap();
    let (candidate, policy) =
        publish_curated_transition(&fixture, &key, &root, &new, 3, None).await;
    assert!(
        library
            .apply_definition_publisher_policy(&policy, Some(&candidate))
            .unwrap_err()
            .message
            .contains("immutable identity")
    );
    assert_eq!(count(&library, "curated_transition_receipts"), 1);
    assert_eq!(count(&library, "curated_artifact_admissions"), 2);
}

#[tokio::test]
async fn curated_cache_restore_cancellation_waits_for_worker_before_cleanup() {
    curated_cache_worker_intervention(CacheIntervention::CancelRestore).await;
}

#[tokio::test]
async fn curated_cache_retention_cancellation_preserves_partial_after_worker_exit() {
    curated_cache_worker_intervention(CacheIntervention::CancelRetain).await;
}

#[tokio::test]
async fn curated_cache_policy_loss_during_copy_refuses_publication_and_preserves_bytes() {
    curated_cache_worker_intervention(CacheIntervention::PolicyLoss).await;
}

enum CacheIntervention {
    CancelRestore,
    CancelRetain,
    PolicyLoss,
    ArtifactRevocationRetain,
    ArtifactWithdrawalRetain,
    ArtifactRevocationRestore,
    ArtifactWithdrawalRestore,
}

macro_rules! curated_cache_artifact_interventions {
    ($($name:ident: $case:ident),+ $(,)?) => {
        $(#[tokio::test] async fn $name() { curated_cache_worker_intervention(CacheIntervention::$case).await; })+
    };
}
curated_cache_artifact_interventions! {
    curated_cache_retention_revocation_during_copy_refuses_publication: ArtifactRevocationRetain,
    curated_cache_retention_withdrawal_during_copy_refuses_publication: ArtifactWithdrawalRetain,
    curated_cache_restore_revocation_during_copy_preserves_cached_bytes: ArtifactRevocationRestore,
    curated_cache_restore_withdrawal_during_copy_preserves_cached_bytes: ArtifactWithdrawalRestore,
}

async fn curated_cache_worker_intervention(intervention: CacheIntervention) {
    use crate::ReleaseProvider;
    use std::{
        io::{Cursor, Write},
        sync::{
            Arc, Condvar, Mutex,
            atomic::{AtomicBool, Ordering},
        },
        time::Duration,
    };
    let clock = std::time::Instant::now();
    println!("curated cache setup begin: {:?}", clock.elapsed());
    let cache_hit = matches!(
        intervention,
        CacheIntervention::CancelRestore
            | CacheIntervention::ArtifactRevocationRestore
            | CacheIntervention::ArtifactWithdrawalRestore
    );
    let artifact_status = match intervention {
        CacheIntervention::ArtifactRevocationRetain
        | CacheIntervention::ArtifactRevocationRestore => Some("revoked"),
        CacheIntervention::ArtifactWithdrawalRetain
        | CacheIntervention::ArtifactWithdrawalRestore => Some("distribution_withdrawn"),
        _ => None,
    };
    let policy_loss =
        matches!(intervention, CacheIntervention::PolicyLoss) || artifact_status.is_some();
    let platform = crate::Platform::current().unwrap();
    let executable = if cfg!(windows) {
        "fixture.exe"
    } else {
        "fixture"
    };
    let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
    archive
        .start_file(
            executable,
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored)
                .unix_permissions(0o755),
        )
        .unwrap();
    archive.write_all(&vec![b'x'; 128 * 1024]).unwrap();
    let bytes = archive.finish().unwrap().into_inner();
    let mut baseline = Catalog::embedded().unwrap().authoritative_document();
    let mut port = metadata_catalog().ports()[0].clone();
    port.platforms = vec![platform];
    port.executable_hints = std::collections::BTreeMap::from([(platform, vec![executable.into()])]);
    let mut record = crate::curated_acquisition::fixture_record();
    record.repository = port.release.repository.clone();
    record.upstream_url = format!("https://github.com/{}", record.repository);
    record.platform = platform;
    record.tag = "v1".into();
    record.filename = format!("game-{}.zip", platform.asset_tokens()[0]);
    record.size = bytes.len() as u64;
    record.sha256 = hex::encode(Sha256::digest(&bytes));
    record.acquisition_url = format!(
        "{}/releases/download/{}/{}",
        record.upstream_url, record.tag, record.filename
    );
    port.release.curated.insert(platform, record.clone());
    baseline.ports.push(port);
    let authored = Catalog::from_json(&serde_json::to_string(&baseline).unwrap()).unwrap();
    println!("curated cache catalog ready: {:?}", clock.elapsed());
    let (_fixture, _key, _root, _directory, library, catalog, mut scope) =
        managed_fixture_for_policy(authored, true).await;
    println!("curated cache managed fixture ready: {:?}", clock.elapsed());
    let withdrawal = if let Some(status) = artifact_status {
        let transitions = serde_json::json!({"future_acceptance_lost":false,"artifacts":[{"asset_id":record.asset_id,"sha256":record.sha256,"status":status}]});
        let (candidate, admission) =
            publish_curated_transition(&_fixture, &_key, &_root, &catalog, 2, Some(transitions))
                .await;
        Some((admission, Some(candidate)))
    } else if policy_loss {
        let mut document = managed_github(2);
        document["policy_schema"] = 4.into();
        document["decision"] = serde_json::json!({"status":"revoked"});
        publish(&_fixture, &_key, 2, &document).await;
        Some((acquire_policy(&_fixture, &_root, ID).await.unwrap(), None))
    } else {
        None
    };
    println!("curated cache transition ready: {:?}", clock.elapsed());
    let server = AcquisitionHttp::new();
    scope.fixture_origin = Some(server.origin.clone());
    let provider = crate::GithubReleaseProvider::with_api_root(server.origin.clone()).unwrap();
    let mut release = server.release(false);
    release[0]["id"] = record.release_id.into();
    release[0]["assets"][0]["id"] = record.asset_id.into();
    release[0]["assets"][0]["name"] = record.filename.clone().into();
    release[0]["assets"][0]["size"] = record.size.into();
    release[0]["assets"][0]["browser_download_url"] = format!(
        "{}{}",
        server.origin,
        reqwest::Url::parse(&record.acquisition_url).unwrap().path()
    )
    .into();
    let tag = serde_json::json!({"ref":"refs/tags/v1", "object":{"type":"commit","sha":record.commit_sha1}});
    server.json(serde_json::json!({"id":scope.repository_id,"archived":false}));
    server.json(release.clone());
    server.json(tag.clone());
    let resolution = provider
        .resolve_scoped(
            catalog.port(ID).unwrap(),
            ReleaseChannel::Stable,
            platform,
            Some(&scope),
        )
        .await
        .unwrap();
    println!("curated cache resolution ready: {:?}", clock.elapsed());
    server.json(serde_json::json!({"id":scope.repository_id,"archived":false}));
    server.json(release);
    server.json(tag);
    let cache_root = library.downloads_dir().join("curated-v1");
    let cache_entry = cache_root.join(format!("{}.asset", record.sha256));
    if cache_hit {
        fs::create_dir_all(&cache_root).unwrap();
        fs::write(&cache_entry, &bytes).unwrap();
    } else {
        server.bytes(&bytes);
    }
    let service = crate::PortcoveService::new(library.clone()).unwrap();
    let (activity, operation) = service
        .begin_cancellable_activity(
            crate::ActivityOperation::Install,
            crate::ActivityTargetKind::Port,
            Some(ID),
        )
        .unwrap();
    let operation_id = activity.id.clone();
    let staging = library.staging_dir().join(&operation_id);
    let latch = Arc::new((
        Mutex::new((None::<(std::path::PathBuf, u64)>, false)),
        Condvar::new(),
    ));
    let hook_latch = latch.clone();
    let finished = Arc::new(AtomicBool::new(false));
    let hook = crate::curated_cache::CacheWorkerTestHook {
        after_copy: Arc::new(move |path, written| {
            if written >= 64 * 1024 {
                let (lock, condition) = &*hook_latch;
                let mut state = lock.lock().unwrap();
                // A regular-file read may be short. Capture the first threshold
                // crossing instead of requiring one exact cumulative chunk size.
                if state.0.is_none() {
                    println!(
                        "curated cache first copy: {:?}; written={written}; cache_hit={cache_hit}",
                        clock.elapsed()
                    );
                    state.0 = Some((path.to_owned(), written));
                    condition.notify_all();
                    while !state.1 {
                        state = condition.wait(state).unwrap();
                    }
                }
            }
            Ok(())
        }),
        finished: finished.clone(),
    };
    let installer = crate::Installer::new(library.clone())
        .unwrap()
        .with_cache_worker_test_hook(hook);
    let request = crate::InstallRequest {
        port_id: ID.into(),
        release: resolution.release.clone(),
        output_root: library.versions_dir().join(ID),
        activate: false,
        managed: None,
        qualification: crate::InstallQualification::from_catalog(&catalog, ID, platform)
            .unwrap()
            .with_acquisition_resolution(resolution)
            .unwrap(),
    };
    println!(
        "curated cache activity request ready: {:?}",
        clock.elapsed()
    );
    println!(
        "curated cache installer start: {:?}; requests={}",
        clock.elapsed(),
        server.requests.lock().unwrap().len()
    );
    let mut observed_phase = None;
    let install = tokio::spawn(async move {
        println!(
            "curated cache installer task entered: {:?}",
            clock.elapsed()
        );
        let result = installer
            .install(request, &operation, |event| {
                if let crate::OperationEventKind::Progress { phase, .. } = event.event
                    && observed_phase.as_ref() != Some(&phase)
                {
                    println!(
                        "curated cache installer phase {phase}: {:?}",
                        clock.elapsed()
                    );
                    observed_phase = Some(phase);
                }
            })
            .await;
        println!("curated cache installer completed: {:?}", clock.elapsed());
        (activity, result)
    });
    // Owner-approved #706 calibration (issuecomments 6190196270/6191752545): preserve the
    // whole-install starting point and every actual partial-copy assertion.
    // #2004 adds exactly PolicyLoss/ArtifactRevocationRestore (issuecomment 6205805576).
    // The final integrated Intel run also missed setup for the two restore
    // variants below. Calibrate only their setup wait under QUALITY's standing
    // authority; retain the actual partial-copy barrier and worker drain.
    // CI 38946153693/a1: PolicyLoss reached its first actual copy about 10.05s
    // after installer start, just beyond the 10s wait. Keep the same whole-install
    // origin, partial-copy barrier, worker drain and overall 30s test safeguard.
    // CI 38953206413/a1: three retention fixtures missed their 10s latch before
    // any copy was observed. Trial 15s with exact 45s whole-case safeguards so
    // intervention and drain retain finite headroom after 12.7-14.6s of setup.
    // Windows CI 39383272662/a1 reached its first real partial copy 5.08s after
    // installer start, just beyond this case's 5s setup latch. Give only this
    // exact intervention 15s, retaining the same starting point, incomplete-copy
    // barrier, worker drain, refusal assertions and outer 30s safeguard.
    // Windows CI 39412944222/a1: PolicyLoss reached the first actual copy 5.054s
    // after installer start, beyond its 5s fixture latch. Give this exact setup
    // wait the same finite 15s headroom; preserve every intervention/drain check
    // and the unchanged 30s whole-case safeguard.
    // Windows CI 39450594334/a1: CancelRetain entered download about 4.24s
    // after installer start and missed the 5s setup latch before any copy.
    // Give this fixture the same finite 15s headroom; preserve the real
    // partial-copy barrier, cancellation/drain checks and finite outer safeguard.
    // Windows focused run 5233faf8: ArtifactRevocationRetain first copied
    // 5.784s after installer start, beyond its 5s latch. Keep the same 15s
    // setup headroom and drain/refusal checks under the finite outer safeguard.
    let latch_timeout = if cfg!(target_os = "windows")
        && matches!(
            intervention,
            CacheIntervention::ArtifactWithdrawalRetain
                | CacheIntervention::PolicyLoss
                | CacheIntervention::CancelRetain
                | CacheIntervention::ArtifactRevocationRetain
        ) {
        Duration::from_secs(15)
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64"))
        && matches!(
            intervention,
            CacheIntervention::PolicyLoss
                | CacheIntervention::CancelRetain
                | CacheIntervention::ArtifactRevocationRetain
                | CacheIntervention::ArtifactWithdrawalRetain
        )
    {
        Duration::from_secs(15)
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64"))
        && matches!(
            intervention,
            CacheIntervention::CancelRestore
                | CacheIntervention::ArtifactRevocationRestore
                | CacheIntervention::ArtifactWithdrawalRestore
        )
    {
        Duration::from_secs(10)
    } else {
        Duration::from_secs(5)
    };
    let reached = tokio::time::timeout(latch_timeout, async {
        loop {
            if let Some(path) = latch.0.lock().unwrap().0.clone() {
                break path;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await;
    println!(
        "curated cache latch resolved: {:?}; reached={}; requests={}",
        clock.elapsed(),
        reached.is_ok(),
        server.requests.lock().unwrap().len()
    );
    println!(
        "curated cache policy intervention begin: {:?}",
        clock.elapsed()
    );
    let disposition = match withdrawal {
        Some((admission, candidate)) => library
            .apply_definition_publisher_policy(&admission, candidate.as_ref())
            .map(|changed| assert!(changed)),
        None => service.request_cancellation(&operation_id).map(|_| ()),
    };
    println!(
        "curated cache policy intervention complete: {:?}",
        clock.elapsed()
    );
    tokio::time::sleep(Duration::from_millis(75)).await;
    let result_finished = install.is_finished();
    let worker_finished = finished.load(Ordering::SeqCst);
    let staging_present = staging.is_dir();
    let journals = crate::operation::OperationStore::new(library.clone()).all();
    let partial_size = reached
        .as_ref()
        .ok()
        .map(|(path, _)| fs::metadata(path).unwrap().len());
    {
        let (lock, condition) = &*latch;
        lock.lock().unwrap().1 = true;
        condition.notify_all();
    }
    let (activity, result) = install.await.unwrap();
    let result = service.finish_activity(activity, result);
    let (partial, copied) = reached.unwrap_or_else(|error| {
        panic!("actual cache copy missed its {latch_timeout:?} latch: {error}; installer={result:?}; worker_finished={worker_finished}; result_finished={result_finished}; final_copy={:?}", latch.0.lock().unwrap().0)
    });
    disposition.unwrap();
    assert!(!result_finished && !worker_finished);
    assert!(staging_present);
    assert_eq!(journals.unwrap().len(), 1);
    assert!((64 * 1024..=128 * 1024).contains(&copied));
    assert!(
        copied < record.size,
        "intervention must observe an incomplete copy"
    );
    assert_eq!(partial_size, Some(copied));
    assert!(finished.load(Ordering::SeqCst));
    let refusal = result.unwrap_err();
    if policy_loss {
        assert_eq!(refusal.code, crate::ErrorCode::Conflict);
        assert!(scope.require_current().is_err());
        assert_eq!(count(&library, "curated_artifact_admissions"), 1);
        if let Some(status) = artifact_status {
            let held = policy::require_curated_artifact_operation(
                &library.connection().unwrap(),
                scope.repository_id,
                &record,
                policy::CuratedArtifactOperation::Acquisition,
            )
            .unwrap_err();
            assert!(held.message.contains(if status == "revoked" {
                "revoked"
            } else {
                "distribution"
            }));
            assert_eq!(count(&library, "curated_transition_receipts"), 1);
        }
    } else {
        assert_eq!(refusal.code, crate::ErrorCode::Cancelled);
    }
    assert!(!staging.exists());
    assert!(library.all_installs().unwrap().is_empty());
    assert!(
        crate::operation::OperationStore::new(library.clone())
            .all()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        library.activities(1).unwrap()[0].status,
        if policy_loss {
            crate::ActivityStatus::Failed
        } else {
            crate::ActivityStatus::Cancelled
        }
    );
    if cache_hit {
        assert!(!partial.exists());
        assert_eq!(fs::read(cache_entry).unwrap(), bytes);
    } else {
        assert!(partial.starts_with(cache_root));
        assert_eq!(
            fs::metadata(&partial).unwrap().len(),
            if policy_loss { record.size } else { copied }
        );
        if policy_loss {
            assert_eq!(fs::read(partial).unwrap(), bytes);
        }
        assert!(
            !cache_entry.exists(),
            "an interrupted private copy cannot publish a cache hit"
        );
    }
    assert!(server.responses.lock().unwrap().is_empty());
}

#[tokio::test]
async fn curated_admitted_scope_resolves_missing_digest_and_revalidates_mutable_identity() {
    curated_installer_fixture(false, None).await;
}

#[tokio::test]
async fn curated_cache_reuse_refuses_corruption_and_preserves_capacity_evidence() {
    curated_installer_fixture(true, None).await;
}

#[tokio::test]
async fn curated_install_refuses_stale_resolution_before_requesting_artifact_bytes() {
    curated_installer_boundary_fixture(
        false,
        None,
        None,
        Some(CuratedInstallRefusal::StaleResolution),
    )
    .await;
}

#[tokio::test]
async fn curated_install_refuses_changed_artifact_bytes_before_publication() {
    curated_installer_boundary_fixture(
        false,
        None,
        None,
        Some(CuratedInstallRefusal::ChangedBytes),
    )
    .await;
}

#[tokio::test]
async fn curated_installed_withdrawal_allows_critical_verification_but_holds_fresh_acquisition() {
    curated_installer_fixture(false, Some("distribution_withdrawn")).await;
}

#[tokio::test]
async fn curated_installed_revocation_holds_critical_verification_and_fresh_acquisition() {
    curated_installer_fixture(false, Some("revoked")).await;
}

#[tokio::test]
async fn curated_rollback_withdrawal_permits_exact_retained_target() {
    curated_retained_rollback_fixture("distribution_withdrawn", RetainedCuratedOperation::Rollback)
        .await;
}

#[tokio::test]
async fn curated_rollback_revocation_preserves_unaffected_active_and_recovery_evidence() {
    curated_retained_rollback_fixture("revoked", RetainedCuratedOperation::Rollback).await;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RetainedCuratedOperation {
    Status,
    Launch,
    LaunchBoundary,
    Rollback,
    Activation,
    ActivationRecovery,
    PublicationRecovery,
    PublicationRecoveryPublished,
    AdoptionRecovery,
    AdoptionRecoveryPublished,
}

#[tokio::test]
async fn curated_adoption_refuses_before_authorization_or_copy() {
    // Refusing a new adoption needs an admitted catalog and an owned source,
    // not two installed versions or a second signed definition revision.
    let platform = crate::Platform::current().unwrap();
    let executable = if cfg!(windows) {
        "fixture.exe"
    } else {
        "fixture"
    };
    let mut document = Catalog::embedded().unwrap().authoritative_document();
    let mut port = metadata_catalog().ports()[0].clone();
    port.platforms = vec![platform];
    port.executable_hints = std::collections::BTreeMap::from([(platform, vec![executable.into()])]);
    let mut record = crate::curated_acquisition::fixture_record();
    record.repository = port.release.repository.clone();
    record.upstream_url = format!("https://github.com/{}", record.repository);
    record.platform = platform;
    record.acquisition_url = format!(
        "{}/releases/download/{}/{}",
        record.upstream_url, record.tag, record.filename
    );
    port.release.curated.insert(platform, record);
    document.ports.push(port);
    let authored = Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap();
    let (_fixture, _key, _root, directory, library, _catalog, _) =
        managed_fixture_for_policy(authored, true).await;
    let source = directory.path().join("unmanaged-owned-source");
    fs::create_dir(&source).unwrap();
    fs::write(
        source.join(executable),
        b"owned nonexecuted adoption source",
    )
    .unwrap();
    crate::permissions::normalize_archive_entry(&source.join(executable), false, true).unwrap();
    let source_tree = crate::library_transfer::reviewed_tree(&source).unwrap();
    let user = library.user_dir(ID);
    fs::create_dir_all(user.join("saves")).unwrap();
    fs::write(user.join("saves/progress.bin"), b"owned adoption progress").unwrap();
    let user_tree = crate::library_transfer::reviewed_tree(&user).unwrap();
    let service = PortcoveService::new(library.clone()).unwrap();
    let error = service
        .adopt(&source, Some(ID), "unconsumed-fixture-token")
        .unwrap_err();
    assert!(
        error
            .message
            .contains("managed GitHub acquisition does not authorize adoption"),
        "{error:?}"
    );
    assert!(
        crate::operation::OperationStore::new(library.clone())
            .all()
            .unwrap()
            .is_empty()
    );
    assert_eq!(count(&library, "installs"), 0);
    assert_eq!(
        crate::library_transfer::reviewed_tree(&source).unwrap(),
        source_tree
    );
    assert_eq!(
        crate::library_transfer::reviewed_tree(&user).unwrap(),
        user_tree
    );
}

macro_rules! curated_adoption_recovery_cases {
    ($($name:ident: $status:literal, $operation:ident),+ $(,)?) => {
        $(#[tokio::test] async fn $name() {
            curated_retained_rollback_fixture($status, RetainedCuratedOperation::$operation).await;
        })+
    };
}
curated_adoption_recovery_cases! {
    curated_adoption_prepared_refuses_unsupported_grant: "available", AdoptionRecovery,
    curated_adoption_published_refuses_unsupported_grant: "available", AdoptionRecoveryPublished,
    curated_adoption_prepared_revocation_preserves_evidence: "revoked", AdoptionRecovery,
    curated_adoption_published_revocation_preserves_evidence: "revoked", AdoptionRecoveryPublished,
    curated_adoption_prepared_withdrawal_preserves_adoption_refusal: "distribution_withdrawn", AdoptionRecovery,
}
// Withdrawal's decision matrix lives in artifact_status_precedence_covers_acquisition_and_local_use:
// acquisition is held, but LocalUse (the adoption-recovery guard) is eligible.
// The prepared withdrawal case proves recovery actually chooses LocalUse and
// reaches the unsupported-adoption refusal rather than an acquisition hold.
// Both real recovery phases above still prove the unsupported-adoption refusal,
// retained journal/payload, unchanged versions/player data, and repeated reopen.
// Signed withdrawal persistence/renewal is exercised by
// curated_distribution_withdrawal_survives_renewal_without_revoking_local_use;
// install recovery separately retains both withdrawal phase boundaries below.

#[tokio::test]
async fn curated_status_revocation_holds_exact_current_and_retained_operations() {
    curated_retained_rollback_fixture("revoked", RetainedCuratedOperation::Status).await;
}

#[tokio::test]
async fn curated_status_withdrawal_holds_acquisition_and_permits_retained_launch() {
    curated_retained_rollback_fixture("distribution_withdrawn", RetainedCuratedOperation::Status)
        .await;
}

#[tokio::test]
async fn curated_retained_launch_revocation_prevents_child_start_after_reopen() {
    curated_retained_rollback_fixture("revoked", RetainedCuratedOperation::Launch).await;
}

#[tokio::test]
async fn curated_retained_launch_withdrawal_supervises_exact_owned_child_after_reopen() {
    curated_retained_rollback_fixture("distribution_withdrawn", RetainedCuratedOperation::Launch)
        .await;
}

#[tokio::test]
async fn curated_launch_boundary_shared_revocation_refuses_before_child_with_valid_baseline() {
    curated_retained_rollback_fixture("revoked", RetainedCuratedOperation::LaunchBoundary).await;
}

#[tokio::test]
async fn curated_publication_recovery_revocation_preserves_private_payload() {
    curated_retained_rollback_fixture("revoked", RetainedCuratedOperation::PublicationRecovery)
        .await;
}

#[tokio::test]
async fn curated_publication_recovery_withdrawal_preserves_private_payload() {
    curated_retained_rollback_fixture(
        "distribution_withdrawn",
        RetainedCuratedOperation::PublicationRecovery,
    )
    .await;
}

#[tokio::test]
async fn curated_publication_recovery_permitted_artifact_commits_once() {
    curated_retained_rollback_fixture("available", RetainedCuratedOperation::PublicationRecovery)
        .await;
}

#[tokio::test]
async fn curated_publication_recovery_published_revocation_preserves_payload() {
    curated_retained_rollback_fixture(
        "revoked",
        RetainedCuratedOperation::PublicationRecoveryPublished,
    )
    .await;
}

#[tokio::test]
async fn curated_publication_recovery_published_withdrawal_preserves_payload() {
    curated_retained_rollback_fixture(
        "distribution_withdrawn",
        RetainedCuratedOperation::PublicationRecoveryPublished,
    )
    .await;
}

#[tokio::test]
async fn curated_publication_recovery_published_permitted_artifact_commits_once() {
    curated_retained_rollback_fixture(
        "available",
        RetainedCuratedOperation::PublicationRecoveryPublished,
    )
    .await;
}

#[tokio::test]
async fn curated_activation_withdrawal_permits_exact_retained_target() {
    curated_retained_rollback_fixture(
        "distribution_withdrawn",
        RetainedCuratedOperation::Activation,
    )
    .await;
}

#[tokio::test]
async fn curated_activation_revocation_preserves_staged_target_and_active_version() {
    curated_retained_rollback_fixture("revoked", RetainedCuratedOperation::Activation).await;
}

#[tokio::test]
async fn curated_activation_recovery_withdrawal_permits_local_commit() {
    curated_retained_rollback_fixture(
        "distribution_withdrawn",
        RetainedCuratedOperation::ActivationRecovery,
    )
    .await;
}

#[tokio::test]
async fn curated_activation_recovery_revocation_retains_interrupted_journal() {
    curated_retained_rollback_fixture("revoked", RetainedCuratedOperation::ActivationRecovery)
        .await;
}

async fn curated_retained_rollback_fixture(status: &str, operation: RetainedCuratedOperation) {
    use crate::operation::{
        LifecycleOperation, LifecycleOperationKind, LifecyclePhase, OperationStore,
    };
    use std::io::{Cursor, Write};
    let clock = std::time::Instant::now();
    let phase = |name: &str| {
        println!(
            "curated retained {operation:?} {status} {name}: {:?}",
            clock.elapsed()
        )
    };
    phase("start");
    let platform = crate::Platform::current().unwrap();
    let executable = if cfg!(windows) {
        "fixture.exe"
    } else {
        "fixture"
    };
    let probe_directory = TempDir::new().unwrap();
    let probe_bytes = matches!(
        operation,
        RetainedCuratedOperation::Launch | RetainedCuratedOperation::LaunchBoundary
    )
    .then(|| fs::read(crate::test_fixture::build_probe(probe_directory.path())).unwrap());
    let mut authored = Catalog::embedded().unwrap().authoritative_document();
    let mut port = metadata_catalog().ports()[0].clone();
    port.platforms = vec![platform];
    port.executable_hints = std::collections::BTreeMap::from([(platform, vec![executable.into()])]);
    let mut artifacts = Vec::new();
    for (index, version) in ["v1", "v2"].into_iter().enumerate() {
        let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
        archive
            .start_file(
                executable,
                zip::write::SimpleFileOptions::default().unix_permissions(0o755),
            )
            .unwrap();
        if let Some(probe_bytes) = &probe_bytes {
            archive.write_all(probe_bytes).unwrap();
            // Distinct fixture archives/install roots preserve exact version
            // identity when versions contain the same owned native launch probe.
            archive
                .start_file(
                    "owned-version.txt",
                    zip::write::SimpleFileOptions::default(),
                )
                .unwrap();
            archive.write_all(version.as_bytes()).unwrap();
        } else {
            archive
                .write_all(format!("owned nonexecuted retained {version}").as_bytes())
                .unwrap();
        }
        let bytes = archive.finish().unwrap().into_inner();
        let mut record = crate::curated_acquisition::fixture_record();
        record.repository = port.release.repository.clone();
        record.upstream_url = format!("https://github.com/{}", record.repository);
        record.platform = platform;
        record.release_id += index as u64;
        record.asset_id += index as u64;
        record.tag = version.into();
        record.filename = format!("game-{}.zip", platform.asset_tokens()[0]);
        record.size = bytes.len() as u64;
        record.sha256 = hex::encode(Sha256::digest(&bytes));
        record.acquisition_url = format!(
            "{}/releases/download/{}/{}",
            record.upstream_url, version, record.filename
        );
        artifacts.push((record, bytes));
    }
    port.release
        .curated
        .insert(platform, artifacts[0].0.clone());
    authored.ports.push(port);
    let authored = Catalog::from_json(&serde_json::to_string(&authored).unwrap()).unwrap();
    let (fixture, key, root, _directory, library, mut catalog, _) =
        managed_fixture_for_policy(authored, true).await;
    phase("initial admission");
    let installer = crate::Installer::new(library.clone()).unwrap();
    let mut delivered = Vec::new();
    for (index, (record, bytes)) in artifacts.iter().enumerate() {
        if index == 1 {
            let mut document = catalog.authoritative_document();
            document
                .ports
                .iter_mut()
                .find(|port| port.id == ID)
                .unwrap()
                .release
                .curated
                .insert(platform, record.clone());
            let next = Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap();
            let bundle = crate::test_fixture::indexed_catalog_bundle_at_revision(&next, ID, 8);
            let mut targets = vec![(INDEX_TARGET.to_owned(), bundle.index)];
            targets.extend(bundle.contents);
            let mut policy_document = managed_policy_for(&targets, true);
            policy_document["policy_schema"] = 4.into();
            policy_document["policy_revision"] = 2.into();
            policy_document["decision"]["curated_acquisition_checks"] = 1.into();
            targets.push((
                format!("policy/official/{ID}.json"),
                serde_json::to_vec(&policy_document).unwrap(),
            ));
            fixture
                .publish_with_policy(
                    &targets,
                    true,
                    &DEFINITION_ROLE_PATHS,
                    later(),
                    Some((&key, 2)),
                )
                .await;
            let candidate = acquire(&fixture, &root).await.unwrap();
            let admission = acquire_policy(&fixture, &root, ID).await.unwrap();
            library
                .apply_definition_publisher_policy(&admission, Some(&candidate))
                .unwrap();
            let eligible = library
                .assess_definition_candidate(&candidate, "official", ID)
                .unwrap()
                .into_eligible()
                .unwrap();
            library.select_definition_candidate(eligible).unwrap();
            catalog = library.load_catalog().unwrap().0;
            phase("second admission");
        }
        // Owned locally materialized retained-install fixtures isolate rollback;
        // actual network acquisition/cache/install is qualified separately.
        assert_eq!(hex::encode(Sha256::digest(bytes)), record.sha256);
        let path = library.versions_dir().join(ID).join(&record.sha256);
        fs::create_dir_all(&path).unwrap();
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let mut entry = archive.by_name(executable).unwrap();
        let mut output = fs::File::create(path.join(executable)).unwrap();
        std::io::copy(&mut entry, &mut output).unwrap();
        drop(output);
        crate::permissions::normalize_archive_entry(&path.join(executable), false, true).unwrap();
        let artifact = crate::ArtifactIdentity {
            asset_name: record.filename.clone(),
            sha256: record.sha256.clone(),
            size: record.size,
        };
        let id = uuid::Uuid::new_v4().to_string();
        let qualification =
            crate::InstallQualification::from_catalog(&catalog, ID, platform).unwrap();
        let (manifest_sha256, selected_executable, runtime) = installer
            .create_manifest(&id, ID, &record.tag, &artifact, &qualification, &path)
            .unwrap();
        let installed = crate::InstallRecord {
            id,
            port_id: ID.into(),
            version: record.tag.clone(),
            path,
            channel: ReleaseChannel::Stable,
            installed_at: Library::now(),
            verified: true,
            staged: false,
            artifact,
            manifest_sha256,
            selected_executable,
            runtime,
        };
        library.register_install(&installed, true).unwrap();
        assert!(installer.verify(&installed).unwrap().valid);
        delivered.push(installed);
        phase(&format!("install {index}"));
    }
    let before = library.status(ID, ReleaseChannel::Stable).unwrap();
    assert_eq!(before.active.unwrap().id, delivered[1].id);
    assert_eq!(before.previous.unwrap().id, delivered[0].id);
    if operation == RetainedCuratedOperation::Launch && status == "distribution_withdrawn" {
        // Successful supervision owns this existing marker mutation; include it
        // in preservation expectations, as in the retained-expiry launch control.
        fs::write(delivered[1].path.join(".portcove-launched"), b"1").unwrap();
    }
    phase("retained baseline begin");
    let trees: Vec<_> = delivered
        .iter()
        .map(|install| crate::library_transfer::reviewed_tree(&install.path).unwrap())
        .collect();
    let user = library.user_dir(ID);
    fs::create_dir_all(user.join("saves")).unwrap();
    fs::write(user.join("saves/progress.bin"), b"owned retained progress").unwrap();
    let user_tree = crate::library_transfer::reviewed_tree(&user).unwrap();
    phase("retained baseline complete");
    if operation == RetainedCuratedOperation::LaunchBoundary {
        let affected = &artifacts[1].0;
        // A second independent port scope first admits these same immutable
        // bytes. Its later hold must not invalidate A's Launch baseline.
        let other = curated_other_scope_catalog(&catalog, affected);
        let (candidate, admission) = publish_curated_transition_for_id(
            &fixture,
            &key,
            &root,
            &other,
            3,
            None,
            "curated-other-scope",
        )
        .await;
        library
            .apply_definition_publisher_policy(&admission, Some(&candidate))
            .unwrap();
        let fresh_scope = policy::acquisition_scope(&library, &catalog, ID)
            .unwrap()
            .unwrap();
        let baseline =
            launch_assessments::assessment_document(&fresh_scope.policy_sha256, 1, vec![]);
        let exact_policy: String = library
            .connection()
            .unwrap()
            .query_row(
                "SELECT policy_json FROM definition_publisher_admission WHERE stable_id=?1",
                [ID],
                |row| row.get(0),
            )
            .unwrap();
        let bundle = crate::test_fixture::indexed_catalog_bundle_at_revision(
            &catalog,
            ID,
            catalog
                .definition_selection(ID)
                .unwrap()
                .definition_revision,
        );
        let mut targets = vec![(INDEX_TARGET.to_owned(), bundle.index)];
        targets.extend(bundle.contents);
        targets.push((
            format!("policy/official/{ID}.json"),
            exact_policy.into_bytes(),
        ));
        let accepted = launch_assessments::publish_assessment_for_targets(
            &fixture, &key, &root, targets, 4, &baseline,
        )
        .await
        .unwrap();
        library
            .apply_definition_launch_assessment(&accepted)
            .unwrap();
        let service = PortcoveService::new(library.clone()).unwrap();
        assert!(service.status(ID).unwrap().readiness.unwrap().launchable);
        let qualification =
            crate::InstallQualification::from_catalog(&catalog, ID, platform).unwrap();
        installer
            .verify_critical(&delivered[1], &qualification)
            .unwrap();
        let mut context =
            DefinitionOperationContext::observed(crate::DefinitionOperation::Launch, true, true);
        context.launch_subject =
            Some(policy::launch_assessment::verified_subject_key(&delivered[1], platform).unwrap());
        let identity = catalog.definition_selection(ID).unwrap();
        assert_eq!(
            library
                .assess_definition_operation(identity, context)
                .unwrap()
                .outcome,
            crate::DefinitionEligibilityOutcome::Eligible
        );
        let transition = serde_json::json!({"future_acceptance_lost":false,"artifacts":[
            {"asset_id":affected.asset_id,"sha256":affected.sha256,"status":"revoked"}]});
        let (candidate, admission) = publish_curated_transition_for_id(
            &fixture,
            &key,
            &root,
            &other,
            5,
            Some(transition),
            "curated-other-scope",
        )
        .await;
        let interventions = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let late = PortcoveService::with_faults(
            library.clone(),
            std::sync::Arc::new(WithdrawPreparation {
                library: library.clone(),
                withdrawal: admission,
                candidate: Some(candidate),
                point: crate::operation::LifecycleFaultPoint::LaunchReadyToSpawn,
                interrupt: false,
                withdrawals: interventions.clone(),
            }),
        )
        .unwrap();
        let release = probe_directory.path().join("late-release");
        let mut started = 0;
        let error = late
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
                },
            )
            .unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Conflict);
        assert!(
            error
                .message
                .contains("accepted curated artifact is revoked"),
            "{error:?}"
        );
        assert_eq!(interventions.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(started, 0);
        assert!(!release.exists());
        assert!(!delivered[1].path.join(".portcove-launched").exists());
        assert!(library.launch_sessions().unwrap().is_empty());
        assert_eq!(
            library
                .assess_definition_operation(identity, context)
                .unwrap()
                .outcome,
            crate::DefinitionEligibilityOutcome::Eligible,
            "definition Launch baseline must remain eligible despite B's exact artifact hold"
        );
        for (install, tree) in delivered.iter().zip(&trees) {
            assert_eq!(
                crate::library_transfer::reviewed_tree(&install.path).unwrap(),
                *tree
            );
        }
        assert_eq!(
            crate::library_transfer::reviewed_tree(&user).unwrap(),
            user_tree
        );
        let after = library.status(ID, ReleaseChannel::Stable).unwrap();
        assert_eq!(after.active.unwrap().id, delivered[1].id);
        assert_eq!(after.previous.unwrap().id, delivered[0].id);
        assert_eq!(count(&library, "curated_artifact_admissions"), 2);
        assert_eq!(count(&library, "curated_artifact_scopes"), 3);
        assert_eq!(count(&library, "curated_transition_receipts"), 1);
        return;
    }
    if matches!(
        operation,
        RetainedCuratedOperation::Status | RetainedCuratedOperation::Launch
    ) {
        let affected = &artifacts[1].0;
        let transitions = serde_json::json!({"future_acceptance_lost":false,"artifacts":[{"asset_id":affected.asset_id,"sha256":affected.sha256,"status":status}]});
        let (candidate, admission) =
            publish_curated_transition(&fixture, &key, &root, &catalog, 3, Some(transitions)).await;
        library
            .apply_definition_publisher_policy(&admission, Some(&candidate))
            .unwrap();
        let eligible = library
            .assess_definition_candidate(&candidate, "official", ID)
            .unwrap()
            .into_eligible()
            .unwrap();
        library.select_definition_candidate(eligible).unwrap();
        // Observe the unchanged selected catalog once. Launch assessments are
        // read from durable state by each status call; they do not replace the
        // selected catalog. Actual launch attempts below still reopen service.
        let service = PortcoveService::new(library.clone()).unwrap();
        let current_catalog = service.catalog();
        phase("launch transition admission");
        let without_baseline = service.status(ID).unwrap();
        assert!(!without_baseline.readiness.unwrap().launchable);
        let baseline_refusal = without_baseline
            .definition_operations
            .iter()
            .find(|item| item.operation == crate::DefinitionOperation::Launch)
            .unwrap();
        assert_ne!(
            baseline_refusal.eligibility.outcome,
            crate::DefinitionEligibilityOutcome::Eligible
        );
        assert_ne!(
            baseline_refusal.eligibility.reason,
            crate::DefinitionEligibilityReason::CuratedArtifactRevoked
        );
        phase("launch without-baseline status");
        let fresh_scope = policy::acquisition_scope(&library, current_catalog, ID)
            .unwrap()
            .unwrap();
        let baseline =
            launch_assessments::assessment_document(&fresh_scope.policy_sha256, 1, vec![]);
        let exact_policy: String = library
            .connection()
            .unwrap()
            .query_row(
                "SELECT policy_json FROM definition_publisher_admission WHERE stable_id=?1",
                [ID],
                |row| row.get(0),
            )
            .unwrap();
        let bundle = crate::test_fixture::indexed_catalog_bundle_at_revision(
            current_catalog,
            ID,
            current_catalog
                .definition_selection(ID)
                .unwrap()
                .definition_revision,
        );
        let mut targets = vec![(INDEX_TARGET.to_owned(), bundle.index)];
        targets.extend(bundle.contents);
        targets.push((
            format!("policy/official/{ID}.json"),
            exact_policy.into_bytes(),
        ));
        let accepted = launch_assessments::publish_assessment_for_targets(
            &fixture, &key, &root, targets, 4, &baseline,
        )
        .await
        .unwrap();
        library
            .apply_definition_launch_assessment(&accepted)
            .unwrap();
        phase("launch baseline admitted");
        let projected = service.status(ID).unwrap();
        let expected_reason = if status == "revoked" {
            crate::DefinitionEligibilityReason::CuratedArtifactRevoked
        } else {
            crate::DefinitionEligibilityReason::CuratedDistributionWithdrawn
        };
        let acquisition = projected
            .definition_operations
            .iter()
            .find(|item| item.operation == crate::DefinitionOperation::Install)
            .unwrap();
        assert_eq!(
            acquisition.eligibility.outcome,
            crate::DefinitionEligibilityOutcome::Hold
        );
        assert_eq!(acquisition.eligibility.reason, expected_reason);
        let launch = projected
            .definition_operations
            .iter()
            .find(|item| item.operation == crate::DefinitionOperation::Launch)
            .unwrap();
        if status == "revoked" {
            assert_eq!(
                launch.eligibility.outcome,
                crate::DefinitionEligibilityOutcome::Hold
            );
            assert_eq!(launch.eligibility.reason, expected_reason);
            assert!(!projected.readiness.as_ref().unwrap().launchable);
            let action = projected
                .port_actions
                .iter()
                .find(|item| item.action == crate::PortAction::Launch)
                .unwrap();
            assert_eq!(action.availability, crate::PortActionAvailability::Held);
            assert_eq!(action.definition.unwrap().reason, expected_reason);
        } else {
            assert_eq!(
                launch.eligibility.outcome,
                crate::DefinitionEligibilityOutcome::Eligible
            );
            assert!(projected.readiness.as_ref().unwrap().launchable);
        }
        if operation == RetainedCuratedOperation::Status {
            // These dedicated cases own bulk/single projection parity. Launch
            // cases below prove child ownership and fresh reopen boundaries.
            let bulk = service
                .statuses()
                .unwrap()
                .into_iter()
                .find(|item| item.port_id == ID)
                .unwrap();
            assert_eq!(bulk.definition_operations, projected.definition_operations);
            assert_eq!(bulk.port_actions, projected.port_actions);
        }
        let rollback = projected
            .port_actions
            .iter()
            .find(|item| item.action == crate::PortAction::Rollback)
            .unwrap();
        assert_eq!(
            rollback.availability,
            crate::PortActionAvailability::Allowed
        );
        phase("launch status projection");
        if operation == RetainedCuratedOperation::Launch {
            for attempt in 0..2 {
                // The second construction consumes durable retained authority,
                // not a caller-provided projection or an in-memory status result.
                let reopened = PortcoveService::new(library.clone()).unwrap();
                let release = probe_directory.path().join(format!("release-{attempt}"));
                let mut started = 0;
                phase(&format!("launch begin {attempt}"));
                let outcome = reopened.supervise_launch(
                    ID,
                    None,
                    &[
                        "--game".into(),
                        "--owned-wait".into(),
                        release.to_string_lossy().into_owned(),
                    ],
                    crate::LaunchStdio::Null,
                    |session| {
                        assert_eq!(session.install_id, delivered[1].id);
                        started += 1;
                        fs::write(&release, b"released").unwrap();
                    },
                );
                phase(&format!("launch returned {attempt}"));
                if status == "revoked" {
                    assert!(outcome.unwrap_err().message.contains("revoked"));
                    assert_eq!(started, 0);
                    assert!(!release.exists());
                    assert!(!delivered[1].path.join(".portcove-launched").exists());
                } else {
                    let outcome = outcome.unwrap();
                    assert!(outcome.successful);
                    assert_eq!(outcome.exit_code, Some(0));
                    assert_eq!(started, 1);
                }
                assert!(reopened.stale_launch_sessions().unwrap().is_empty());
                let after = library.status(ID, ReleaseChannel::Stable).unwrap();
                assert_eq!(after.active.unwrap().id, delivered[1].id);
                assert_eq!(after.previous.unwrap().id, delivered[0].id);
            }
        }
        for (install, tree) in delivered.iter().zip(&trees) {
            assert!(installer.verify(install).unwrap().valid);
            assert_eq!(
                crate::library_transfer::reviewed_tree(&install.path).unwrap(),
                *tree
            );
        }
        assert_eq!(
            crate::library_transfer::reviewed_tree(&user).unwrap(),
            user_tree
        );
        assert_eq!(count(&library, "installs"), 2);
        assert_eq!(count(&library, "curated_artifact_admissions"), 2);
        assert_eq!(count(&library, "curated_transition_receipts"), 1);
        return;
    }
    if matches!(
        operation,
        RetainedCuratedOperation::PublicationRecovery
            | RetainedCuratedOperation::PublicationRecoveryPublished
            | RetainedCuratedOperation::AdoptionRecovery
            | RetainedCuratedOperation::AdoptionRecoveryPublished
    ) {
        let unsupported_adoption = matches!(
            operation,
            RetainedCuratedOperation::AdoptionRecovery
                | RetainedCuratedOperation::AdoptionRecoveryPublished
        );
        let mut journal = LifecycleOperation::new(
            uuid::Uuid::new_v4().to_string(),
            if unsupported_adoption {
                LifecycleOperationKind::Adopt
            } else {
                LifecycleOperationKind::Install
            },
            ID,
        );
        let staging = library.staging_dir().join(&journal.id);
        let payload = staging.join("payload");
        phase("publication payload preparation begin");
        crate::service::copy_tree(&delivered[1].path, &payload).unwrap();
        let original = &delivered[1];
        let install_id = uuid::Uuid::new_v4().to_string();
        let qualification =
            crate::InstallQualification::from_catalog(&catalog, ID, platform).unwrap();
        let (manifest_sha256, selected_executable, runtime) = installer
            .create_manifest(
                &install_id,
                ID,
                &original.version,
                &original.artifact,
                &qualification,
                &payload,
            )
            .unwrap();
        let published = crate::InstallRecord {
            id: install_id,
            path: library
                .versions_dir()
                .join(ID)
                .join(format!("{}-resumed", original.artifact.sha256)),
            manifest_sha256,
            selected_executable,
            runtime,
            ..original.clone()
        };
        let private = crate::InstallRecord {
            path: payload.clone(),
            ..published.clone()
        };
        assert!(installer.verify(&private).unwrap().valid);
        let private_tree = crate::library_transfer::reviewed_tree(&payload).unwrap();
        phase("publication payload preparation complete");
        let already_published = matches!(
            operation,
            RetainedCuratedOperation::PublicationRecoveryPublished
                | RetainedCuratedOperation::AdoptionRecoveryPublished
        );
        let interrupted_phase = if already_published {
            crate::durability::rename_noreplace(&payload, &published.path).unwrap();
            LifecyclePhase::PayloadPublished
        } else {
            LifecyclePhase::Prepared
        };
        journal.phase = interrupted_phase;
        journal.install = Some(published.clone());
        journal.paths.staging = Some(staging.clone());
        journal.paths.final_path = Some(published.path.clone());
        journal.activate = true;
        let store = OperationStore::new(library.clone());
        store.put(&mut journal).unwrap();
        phase("publication journal persisted");
        if status != "available" {
            let affected = &artifacts[1].0;
            let transitions = serde_json::json!({"future_acceptance_lost":false,"artifacts":[{"asset_id":affected.asset_id,"sha256":affected.sha256,"status":status}]});
            let (candidate, admission) =
                publish_curated_transition(&fixture, &key, &root, &catalog, 3, Some(transitions))
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
        }
        let current = library.load_catalog().unwrap().0;
        policy::acquisition_scope(&library, &current, ID)
            .unwrap()
            .unwrap()
            .require_current()
            .unwrap();
        phase("publication current scope ready");
        for attempt in 0..2 {
            phase(&format!("publication reopen begin {attempt}"));
            let _reopened = PortcoveService::new(library.clone()).unwrap();
            phase(&format!("publication reopen complete {attempt}"));
            let after = library.status(ID, ReleaseChannel::Stable).unwrap();
            if status == "available" && !unsupported_adoption {
                assert_eq!(after.active.unwrap().id, published.id);
                assert_eq!(after.previous.unwrap().id, delivered[1].id);
                assert!(store.get(&journal.id).unwrap().is_none());
                assert!(!staging.exists());
                assert_eq!(
                    crate::library_transfer::reviewed_tree(&published.path).unwrap(),
                    private_tree
                );
                assert_eq!(count(&library, "installs"), 3);
            } else {
                assert_eq!(after.active.unwrap().id, delivered[1].id);
                assert_eq!(after.previous.unwrap().id, delivered[0].id);
                let retained = store.get(&journal.id).unwrap().unwrap();
                assert_eq!(retained.phase, interrupted_phase);
                assert_eq!(retained.install.unwrap().id, published.id);
                assert!(
                    retained
                        .last_error
                        .unwrap()
                        .contains(if status == "revoked" {
                            "revoked"
                        } else if unsupported_adoption {
                            "managed GitHub acquisition does not authorize adoption"
                        } else {
                            "distribution"
                        })
                );
                assert_eq!(published.path.exists(), already_published);
                assert_eq!(payload.exists(), !already_published);
                assert!(staging.exists());
                assert_eq!(
                    crate::library_transfer::reviewed_tree(if already_published {
                        &published.path
                    } else {
                        &payload
                    })
                    .unwrap(),
                    private_tree
                );
                assert_eq!(count(&library, "installs"), 2);
            }
            for (install, tree) in delivered.iter().zip(&trees) {
                assert!(installer.verify(install).unwrap().valid);
                assert_eq!(
                    crate::library_transfer::reviewed_tree(&install.path).unwrap(),
                    *tree
                );
            }
            assert!(
                installer
                    .verify_critical(&delivered[0], &qualification)
                    .is_ok()
            );
            assert_eq!(
                crate::library_transfer::reviewed_tree(&user).unwrap(),
                user_tree
            );
            phase(&format!("publication preservation complete {attempt}"));
        }
        assert_eq!(count(&library, "curated_artifact_admissions"), 2);
        assert_eq!(
            count(&library, "curated_transition_receipts"),
            i64::from(status != "available")
        );
        return;
    }
    let store = OperationStore::new(library.clone());
    let mut interrupted = LifecycleOperation::new(
        uuid::Uuid::new_v4().to_string(),
        LifecycleOperationKind::Activate,
        ID,
    );
    interrupted.install = Some(delivered[0].clone());
    if operation != RetainedCuratedOperation::Rollback {
        library.register_install(&delivered[0], false).unwrap();
        if operation == RetainedCuratedOperation::ActivationRecovery {
            store.put(&mut interrupted).unwrap();
        }
    }
    let affected = &artifacts[0].0;
    let transitions = serde_json::json!({"future_acceptance_lost":false,"artifacts":[{"asset_id":affected.asset_id,"sha256":affected.sha256,"status":status}]});
    let (candidate, admission) =
        publish_curated_transition(&fixture, &key, &root, &catalog, 3, Some(transitions)).await;
    library
        .apply_definition_publisher_policy(&admission, Some(&candidate))
        .unwrap();
    let eligible = library
        .assess_definition_candidate(&candidate, "official", ID)
        .unwrap()
        .into_eligible()
        .unwrap();
    library.select_definition_candidate(eligible).unwrap();
    let current_catalog = library.load_catalog().unwrap().0;
    policy::acquisition_scope(&library, &current_catalog, ID)
        .unwrap()
        .unwrap()
        .require_current()
        .unwrap();
    phase("transition admission and fresh scope");
    let attempts = if operation == RetainedCuratedOperation::Activation {
        1
    } else {
        2
    };
    for attempt in 0..attempts {
        // Service construction executes actual startup recovery each time.
        let service = PortcoveService::new(library.clone()).unwrap();
        phase(&format!("startup {attempt}"));
        if operation == RetainedCuratedOperation::Rollback && attempt == 0 {
            // Prove held/allowed rollback presentation once. Each real rollback
            // and reopen still checks its exact installed identity and trees.
            let projected = service.status(ID).unwrap();
            let rollback = projected
                .port_actions
                .iter()
                .find(|action| action.action == crate::PortAction::Rollback)
                .unwrap();
            if status == "revoked" {
                assert_eq!(rollback.availability, crate::PortActionAvailability::Held);
                assert_eq!(
                    rollback.reason,
                    crate::PortActionReason::DefinitionIneligible
                );
                assert_eq!(
                    rollback.definition.unwrap().reason,
                    crate::DefinitionEligibilityReason::CuratedArtifactRevoked
                );
            } else {
                assert_eq!(
                    rollback.availability,
                    crate::PortActionAvailability::Allowed
                );
                assert!(rollback.definition.is_none());
            }
            // The unaffected current v2 identity remains eligible even when the
            // previous v1 identity is held. Single and bulk status agree.
            let install = projected
                .definition_operations
                .iter()
                .find(|item| item.operation == crate::DefinitionOperation::Install)
                .unwrap();
            assert_eq!(
                install.eligibility.outcome,
                crate::DefinitionEligibilityOutcome::Eligible
            );
            let bulk = service
                .statuses()
                .unwrap()
                .into_iter()
                .find(|item| item.port_id == ID)
                .unwrap();
            assert_eq!(bulk.definition_operations, projected.definition_operations);
            assert_eq!(bulk.port_actions, projected.port_actions);
        }
        phase(&format!("rollback action projection {attempt}"));
        if operation != RetainedCuratedOperation::ActivationRecovery {
            let result = match operation {
                RetainedCuratedOperation::Rollback => service.rollback(ID),
                RetainedCuratedOperation::Activation => service.activate_staged(ID),
                _ => unreachable!(),
            };
            phase(&format!("execute {attempt}"));
            if status == "revoked" {
                assert!(result.unwrap_err().message.contains("revoked"));
            } else {
                assert_eq!(result.unwrap().id, delivered[attempt].id);
            }
        }
        let after = library.status(ID, ReleaseChannel::Stable).unwrap();
        if status == "revoked" {
            assert_eq!(after.active.unwrap().id, delivered[1].id);
            assert_eq!(after.previous.unwrap().id, delivered[0].id);
            if operation != RetainedCuratedOperation::Rollback {
                assert_eq!(after.staged.unwrap().id, delivered[0].id);
            }
            if operation == RetainedCuratedOperation::ActivationRecovery {
                let retained = store.get(&interrupted.id).unwrap().unwrap();
                assert_eq!(retained.phase, LifecyclePhase::Preparing);
                assert_eq!(retained.install.unwrap().id, delivered[0].id);
                assert!(retained.last_error.unwrap().contains("revoked"));
                assert_eq!(store.all().unwrap().len(), 1);
            }
        } else {
            let expected = if operation == RetainedCuratedOperation::Rollback {
                attempt
            } else {
                0
            };
            assert_eq!(after.active.unwrap().id, delivered[expected].id);
            if operation != RetainedCuratedOperation::Rollback {
                assert!(after.staged.is_none());
                assert!(store.all().unwrap().is_empty());
            }
        }
        assert!(
            installer
                .verify_critical(
                    &delivered[1],
                    &crate::InstallQualification::from_catalog(&catalog, ID, platform).unwrap()
                )
                .is_ok()
        );
        for (install, tree) in delivered.iter().zip(&trees) {
            assert!(installer.verify(install).unwrap().valid);
            assert_eq!(
                crate::library_transfer::reviewed_tree(&install.path).unwrap(),
                *tree
            );
        }
        assert_eq!(
            crate::library_transfer::reviewed_tree(&user).unwrap(),
            user_tree
        );
        phase(&format!("preservation complete {attempt}"));
    }
    assert_eq!(count(&library, "installs"), 2);
    assert_eq!(count(&library, "curated_artifact_admissions"), 2);
    assert_eq!(count(&library, "curated_transition_receipts"), 1);
}

async fn curated_installer_fixture(cache_controls: bool, artifact_status: Option<&str>) {
    curated_installer_boundary_fixture(cache_controls, artifact_status, None, None).await;
}

async fn apply_curated_launch_baseline(
    fixture: &RepositoryFixture,
    key: &Key,
    root: &[u8],
    library: &Library,
    catalog: &Catalog,
    assessment_revision: u64,
    metadata_version: u64,
) {
    let scope = policy::acquisition_scope(library, catalog, ID)
        .unwrap()
        .unwrap();
    let baseline =
        launch_assessments::assessment_document(&scope.policy_sha256, assessment_revision, vec![]);
    // Preserve the exact admitted schema-4 grant when publishing its signed
    // launch baseline; a reconstructed generic grant would change its identity.
    let exact_policy: String = library
        .connection()
        .unwrap()
        .query_row(
            "SELECT policy_json FROM definition_publisher_admission WHERE stable_id=?1",
            [ID],
            |row| row.get(0),
        )
        .unwrap();
    let bundle = crate::test_fixture::indexed_catalog_bundle_at_revision(
        catalog,
        ID,
        catalog
            .definition_selection(ID)
            .unwrap()
            .definition_revision,
    );
    let mut targets = vec![(INDEX_TARGET.to_owned(), bundle.index)];
    targets.extend(bundle.contents);
    targets.push((
        format!("policy/official/{ID}.json"),
        exact_policy.into_bytes(),
    ));
    let accepted = launch_assessments::publish_assessment_for_targets(
        fixture,
        key,
        root,
        targets,
        metadata_version,
        &baseline,
    )
    .await
    .unwrap();
    library
        .apply_definition_launch_assessment(&accepted)
        .unwrap();
}

#[derive(Clone, Copy)]
enum CuratedInstallRefusal {
    StaleResolution,
    ChangedBytes,
}

macro_rules! curated_install_boundary_cases {
    ($($name:ident: $status:literal, $point:ident,)*) => {$(
        #[tokio::test]
        async fn $name() {
            curated_installer_boundary_fixture(false, Some($status),
                Some(crate::operation::LifecycleFaultPoint::$point), None).await;
        }
    )*};
}
curated_install_boundary_cases! {
    curated_install_prepared_revocation_preserves_owned_payload: "revoked", InstallPrepared,
    curated_install_prepared_withdrawal_preserves_owned_payload: "distribution_withdrawn", InstallPrepared,
    curated_install_published_revocation_preserves_owned_payload: "revoked", InstallPublished,
    curated_install_published_withdrawal_preserves_owned_payload: "distribution_withdrawn", InstallPublished,
}

async fn curated_installer_boundary_fixture(
    cache_controls: bool,
    artifact_status: Option<&str>,
    boundary: Option<crate::operation::LifecycleFaultPoint>,
    refusal: Option<CuratedInstallRefusal>,
) {
    use crate::ReleaseProvider;
    use std::io::{Cursor, Write};
    let clock = std::time::Instant::now();
    let phase = |name: &str| println!("curated installer {name}: {:?}", clock.elapsed());
    let platform = crate::Platform::current().unwrap();
    let executable = if cfg!(windows) {
        "fixture.exe"
    } else {
        "fixture"
    };
    let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
    archive
        .start_file(
            executable,
            zip::write::SimpleFileOptions::default().unix_permissions(0o755),
        )
        .unwrap();
    archive
        .write_all(b"Owned nonexecuted curated byte fixture")
        .unwrap();
    let bytes = archive.finish().unwrap().into_inner();
    let mut baseline = Catalog::embedded().unwrap().authoritative_document();
    let mut port = metadata_catalog().ports()[0].clone();
    port.platforms = vec![platform];
    port.executable_hints.clear();
    port.executable_hints
        .insert(platform, vec![executable.into()]);
    let mut record = crate::curated_acquisition::fixture_record();
    record.repository = port.release.repository.clone();
    record.upstream_url = format!("https://github.com/{}", record.repository);
    record.platform = platform;
    record.tag = "v1".into();
    record.filename = format!("game-{}.zip", platform.asset_tokens()[0]);
    record.size = bytes.len() as u64;
    record.sha256 = hex::encode(Sha256::digest(&bytes));
    record.acquisition_url = format!(
        "{}/releases/download/{}/{}",
        record.upstream_url, record.tag, record.filename
    );
    port.release.curated.insert(record.platform, record.clone());
    assert!(
        crate::DefinitionAcquisitionScope::validate_port(&port).is_err(),
        "legacy scope must refuse curated content"
    );
    baseline.ports.push(port);
    let authored = Catalog::from_json(&serde_json::to_string(&baseline).unwrap()).unwrap();
    let (fixture, key, root, _directory, library, catalog, mut scope) =
        managed_fixture_for_policy(authored, true).await;
    let original_candidate = acquire(&fixture, &root).await.unwrap();
    let original_admission = acquire_policy(&fixture, &root, ID).await.unwrap();
    phase("initial admission and reacquisition");
    assert_eq!(scope.curated_checks, Some(1));
    let server = AcquisitionHttp::new();
    scope.fixture_origin = Some(server.origin.clone());
    let provider = crate::GithubReleaseProvider::with_api_root(server.origin.clone()).unwrap();
    let mut release = server.release(false);
    release[0]["id"] = record.release_id.into();
    release[0]["assets"][0]["id"] = record.asset_id.into();
    release[0]["assets"][0]["size"] = record.size.into();
    release[0]["assets"][0]["name"] = record.filename.clone().into();
    let path = reqwest::Url::parse(&record.acquisition_url)
        .unwrap()
        .path()
        .to_owned();
    release[0]["assets"][0]["browser_download_url"] = format!("{}{path}", server.origin).into();
    let tag = serde_json::json!({"ref":"refs/tags/v1", "object":{"type":"commit","sha":record.commit_sha1}});
    for iteration in 0..2 {
        phase(&format!("iteration {iteration} begin"));
        let before = server.requests.lock().unwrap().len();
        server.json(serde_json::json!({"id":scope.repository_id,"archived":false}));
        server.json(release.clone());
        server.json(tag.clone());
        let resolved = provider
            .resolve_scoped(
                catalog.port(ID).unwrap(),
                ReleaseChannel::Stable,
                record.platform,
                Some(&scope),
            )
            .await
            .unwrap();
        phase(&format!("resolve {iteration}"));
        assert_eq!(resolved.release.asset.sha256, record.sha256);
        assert_eq!(resolved.release.asset.size, record.size);
        assert_eq!(
            server.requests.lock().unwrap().len(),
            before + 3,
            "mutable curated metadata must be read even inside the selection-cache TTL"
        );
        if iteration == 0 {
            let installer = crate::Installer::new(library.clone()).unwrap();
            let qualification =
                crate::InstallQualification::from_catalog(&catalog, ID, record.platform).unwrap();
            phase("immutable install qualification captured");
            let request =
                |resolution: crate::ScopedResolvedRelease, _suffix: &str| crate::InstallRequest {
                    port_id: ID.into(),
                    release: resolution.release.clone(),
                    output_root: library.versions_dir().join(ID),
                    activate: false,
                    managed: None,
                    qualification: qualification
                        .clone()
                        .with_acquisition_resolution(resolution)
                        .unwrap(),
                };
            // Each independent refusal owns an actual installer attempt. Do not
            // repeat these controls before unrelated identity/cache lifecycles.
            if let Some(CuratedInstallRefusal::StaleResolution) = refusal {
                let mut moved_tag = tag.clone();
                moved_tag["object"]["sha"] = "d".repeat(40).into();
                server.json(serde_json::json!({"id":scope.repository_id,"archived":false}));
                server.json(release.clone());
                server.json(moved_tag);
                let before = server.requests.lock().unwrap().len();
                assert!(
                    installer
                        .install(
                            request(resolved.clone(), "-stale-proof"),
                            &crate::operation::OperationCoordinator::new("install", None),
                            |_| {},
                        )
                        .await
                        .is_err()
                );
                assert_eq!(
                    server.requests.lock().unwrap().len(),
                    before + 3,
                    "a stale resolution must refuse before requesting artifact bytes"
                );
                assert_eq!(count(&library, "installs"), 0);
                assert!(server.responses.lock().unwrap().is_empty());
                return;
            }
            if let Some(CuratedInstallRefusal::ChangedBytes) = refusal {
                let mut changed_bytes = bytes.clone();
                changed_bytes[0] ^= 1;
                server.json(serde_json::json!({"id":scope.repository_id,"archived":false}));
                server.json(release.clone());
                server.json(tag.clone());
                server.bytes(&changed_bytes);
                let refused = installer
                    .install(
                        request(resolved.clone(), "-changed-bytes"),
                        &crate::operation::OperationCoordinator::new("install", None),
                        |_| {},
                    )
                    .await
                    .unwrap_err();
                assert_eq!(refused.code, crate::ErrorCode::Verification);
                assert!(refused.message.contains("SHA-256"));
                assert_eq!(count(&library, "installs"), 0);
                assert!(server.responses.lock().unwrap().is_empty());
                return;
            }
            // Cache reuse must follow the real interrupted installer that
            // populated verified bytes; a preseeded file cannot replace it.
            if cache_controls {
                server.json(serde_json::json!({"id":scope.repository_id,"archived":false}));
                server.json(release.clone());
                server.json(tag.clone());
                server.bytes(&bytes);
                struct BeforePublication;
                impl crate::operation::LifecycleFaultInjector for BeforePublication {
                    fn check(
                        &self,
                        point: crate::operation::LifecycleFaultPoint,
                    ) -> crate::Result<()> {
                        if point == crate::operation::LifecycleFaultPoint::InstallReadyToPublish {
                            Err(PortcoveError::state(
                                "owned fixture interruption before publication",
                            ))
                        } else {
                            Ok(())
                        }
                    }
                }
                let interrupted = crate::Installer::with_faults(
                    library.clone(),
                    std::sync::Arc::new(BeforePublication),
                )
                .unwrap();
                let refusal = interrupted
                    .install(
                        request(resolved.clone(), "-populate-cache"),
                        &crate::operation::OperationCoordinator::new("install", None),
                        |_| {},
                    )
                    .await
                    .unwrap_err();
                assert!(refusal.message.contains("owned fixture interruption"));
                assert_eq!(count(&library, "installs"), 0);
            }
            phase("pre-install refusals complete");
            let before = server.requests.lock().unwrap().len();
            server.json(serde_json::json!({"id":scope.repository_id,"archived":false}));
            server.json(release.clone());
            server.json(tag.clone());
            if !cache_controls {
                server.bytes(&bytes);
            }
            // Cache controls queue no artifact response: installation refreshes
            // metadata and reuses only reverified immutable cached bytes.
            // Other controls acquire their actual admitted payload here.
            if let Some(point) = boundary {
                use crate::operation::{LifecyclePhase, OperationStore};
                let status = artifact_status.unwrap();
                let transitions = serde_json::json!({"future_acceptance_lost":false,
                    "artifacts":[{"asset_id":record.asset_id,"sha256":record.sha256,"status":status}]});
                phase("boundary transition publication begin");
                let (candidate, admission) = publish_curated_transition(
                    &fixture,
                    &key,
                    &root,
                    &catalog,
                    2,
                    Some(transitions),
                )
                .await;
                phase("boundary transition publication complete");
                let interventions = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
                let guarded = crate::Installer::with_faults(
                    library.clone(),
                    std::sync::Arc::new(WithdrawPreparation {
                        library: library.clone(),
                        withdrawal: admission,
                        candidate: Some(candidate),
                        point,
                        interrupt: false,
                        withdrawals: interventions.clone(),
                    }),
                )
                .unwrap();
                let mut observed_install_phase = None;
                phase("boundary install begin");
                let refusal = guarded
                    .install(
                        request(resolved.clone(), ""),
                        &crate::operation::OperationCoordinator::new("install", None),
                        |event| {
                            if let crate::OperationEventKind::Progress {
                                phase: progress, ..
                            } = event.event
                                && observed_install_phase.as_ref() != Some(&progress)
                            {
                                phase(&format!("boundary install progress {progress}"));
                                observed_install_phase = Some(progress);
                            }
                        },
                    )
                    .await
                    .unwrap_err();
                phase("boundary install complete");
                assert_eq!(refusal.code, crate::ErrorCode::Conflict);
                assert_eq!(interventions.load(std::sync::atomic::Ordering::SeqCst), 1);
                assert_eq!(server.requests.lock().unwrap().len(), before + 4);
                assert!(server.responses.lock().unwrap().is_empty());
                assert_eq!(count(&library, "installs"), 0);
                let journals = OperationStore::new(library.clone()).all().unwrap();
                assert_eq!(journals.len(), 1);
                let journal = &journals[0];
                let published = point == crate::operation::LifecycleFaultPoint::InstallPublished;
                let expected_phase = if published {
                    LifecyclePhase::PayloadPublished
                } else {
                    LifecyclePhase::Prepared
                };
                assert_eq!(journal.phase, expected_phase);
                let staging = journal.paths.staging.as_ref().unwrap();
                let destination = journal.paths.final_path.as_ref().unwrap();
                let payload = staging.join("payload");
                assert!(staging.exists());
                assert_eq!(destination.exists(), published);
                assert_eq!(payload.exists(), !published);
                let retained = if published { destination } else { &payload };
                assert_eq!(
                    fs::read(retained.join(executable)).unwrap(),
                    b"Owned nonexecuted curated byte fixture"
                );
                let tree = crate::library_transfer::reviewed_tree(retained).unwrap();
                let cached = library
                    .downloads_dir()
                    .join("curated-v1")
                    .join(format!("{}.asset", record.sha256));
                assert_eq!(fs::read(&cached).unwrap(), bytes);
                for attempt in 0..2 {
                    phase(&format!("boundary reopen begin {attempt}"));
                    let reopened = crate::PortcoveService::new(library.clone()).unwrap();
                    drop(reopened);
                    phase(&format!("boundary reopen complete {attempt}"));
                    let held = OperationStore::new(library.clone()).all().unwrap();
                    assert_eq!(held.len(), 1);
                    assert_eq!(held[0].id, journal.id);
                    assert_eq!(held[0].phase, expected_phase);
                    assert!(held[0].last_error.as_ref().unwrap().contains(
                        if status == "revoked" {
                            "revoked"
                        } else {
                            "distribution"
                        }
                    ));
                    assert_eq!(count(&library, "installs"), 0);
                    assert_eq!(
                        crate::library_transfer::reviewed_tree(retained).unwrap(),
                        tree
                    );
                    assert_eq!(destination.exists(), published);
                    assert_eq!(payload.exists(), !published);
                    assert!(staging.exists());
                    assert_eq!(fs::read(&cached).unwrap(), bytes);
                    phase(&format!("boundary preservation complete {attempt}"));
                }
                assert_eq!(count(&library, "curated_artifact_admissions"), 1);
                assert_eq!(count(&library, "curated_transition_receipts"), 1);
                return;
            }
            let mut observed_install_phase = None;
            phase("actual install begin");
            let installed = installer
                .install(
                    request(resolved.clone(), ""),
                    &crate::operation::OperationCoordinator::new("install", None),
                    |event| {
                        if let crate::OperationEventKind::Progress {
                            phase: progress, ..
                        } = event.event
                            && observed_install_phase.as_ref() != Some(&progress)
                        {
                            phase(&format!("actual install progress {progress}"));
                            observed_install_phase = Some(progress);
                        }
                    },
                )
                .await
                .unwrap();
            phase("actual install complete; verification begin");
            assert!(installer.verify(&installed).unwrap().valid);
            assert_eq!(count(&library, "installs"), 1);
            assert_eq!(
                server.requests.lock().unwrap().len(),
                before + if cache_controls { 3 } else { 4 }
            );
            phase("actual install verified");
            if let Some(status) = artifact_status {
                let qualification =
                    crate::InstallQualification::from_catalog(&catalog, ID, platform).unwrap();
                let original_tree =
                    crate::library_transfer::reviewed_tree(&installed.path).unwrap();
                let cached = library
                    .downloads_dir()
                    .join("curated-v1")
                    .join(format!("{}.asset", record.sha256));
                assert_eq!(fs::read(&cached).unwrap(), bytes);
                let before_references = server.requests.lock().unwrap().len();
                phase("installed reference launch baseline begin");
                apply_curated_launch_baseline(&fixture, &key, &root, &library, &catalog, 1, 2)
                    .await;
                let service = crate::PortcoveService::new(library.clone()).unwrap();
                let setup_id = "retained-before-transition";
                let preview = service
                    .preview_retained_build_binding(ID, setup_id, &installed.id)
                    .unwrap();
                let authorization = service
                    .authorize_retained_build_binding(
                        ID,
                        setup_id,
                        &installed.id,
                        &preview.preview_sha256,
                    )
                    .unwrap();
                let reference = service
                    .bind_retained_build(ID, setup_id, &installed.id, &authorization.token)
                    .unwrap();
                assert_eq!(reference.build.install_id, installed.id);
                assert_eq!(reference.build.artifact, installed.artifact);
                let initial = service.resolve_retained_build(ID, setup_id).unwrap();
                assert_eq!(initial.reference, reference);
                assert_eq!(
                    initial.availability,
                    crate::RetainedBuildAvailability::Verified
                );
                assert_eq!(initial.install.unwrap().id, installed.id);
                assert!(initial.gap.is_none());
                assert_eq!(count(&library, "retained_build_references"), 1);

                // A later hold must be checked again when an already reviewed
                // binding executes, as well as when a new review is requested.
                let pending_setup_id = "reviewed-before-transition";
                let pending_preview = service
                    .preview_retained_build_binding(ID, pending_setup_id, &installed.id)
                    .unwrap();
                let pending_authorization = service
                    .authorize_retained_build_binding(
                        ID,
                        pending_setup_id,
                        &installed.id,
                        &pending_preview.preview_sha256,
                    )
                    .unwrap();
                drop(service);
                assert_eq!(server.requests.lock().unwrap().len(), before_references);
                let transitions = serde_json::json!({"future_acceptance_lost":false, "artifacts":[
                    {"asset_id":record.asset_id,"sha256":record.sha256,"status":status}]});
                phase("installed transition publication begin");
                let (candidate, admission) = publish_curated_transition(
                    &fixture,
                    &key,
                    &root,
                    &catalog,
                    3,
                    Some(transitions),
                )
                .await;
                phase("installed transition publication complete; application begin");
                library
                    .apply_definition_publisher_policy(&admission, Some(&candidate))
                    .unwrap();
                phase("installed transition applied; critical verification begin");
                let critical = installer.verify_critical(&installed, &qualification);
                if status == "revoked" {
                    assert!(critical.unwrap_err().message.contains("revoked"));
                } else {
                    assert_eq!(critical.unwrap(), installed.path.join(executable));
                }
                phase("critical verification complete; fresh scope begin");
                // Reassess and select the new exact policy. These acquisition
                // refusals must not be explained by an obsolete in-memory scope.
                let eligible = library
                    .assess_definition_candidate(&candidate, "official", ID)
                    .unwrap()
                    .into_eligible()
                    .unwrap();
                library.select_definition_candidate(eligible).unwrap();
                let (current_catalog, _) = library.load_catalog().unwrap();
                // Bind the baseline to the new policy so withdrawal's retained
                // use is not mistaken for a missing or stale launch-check hold.
                apply_curated_launch_baseline(
                    &fixture,
                    &key,
                    &root,
                    &library,
                    &current_catalog,
                    2,
                    4,
                )
                .await;
                let reopened = crate::PortcoveService::new(library.clone()).unwrap();
                let retained = reopened.resolve_retained_build(ID, setup_id).unwrap();
                assert_eq!(retained.reference, reference);
                if status == "revoked" {
                    assert_eq!(
                        retained.availability,
                        crate::RetainedBuildAvailability::Held
                    );
                    assert!(retained.install.is_none());
                    let gap = retained.gap.unwrap();
                    assert_eq!(gap.code, crate::ErrorCode::Conflict);
                    assert!(gap.message.contains("revoked"));
                    assert_eq!(gap.details.get("sha256"), Some(&record.sha256));
                    let refused = reopened
                        .preview_retained_build_binding(ID, pending_setup_id, &installed.id)
                        .unwrap_err();
                    assert_eq!(refused.code, crate::ErrorCode::Conflict);
                    assert!(refused.message.contains("revoked"));
                    let refused = reopened
                        .bind_retained_build(
                            ID,
                            pending_setup_id,
                            &installed.id,
                            &pending_authorization.token,
                        )
                        .unwrap_err();
                    assert_eq!(refused.code, crate::ErrorCode::Conflict);
                    assert!(refused.message.contains("revoked"));
                    assert_eq!(refused.details.get("sha256"), Some(&record.sha256));
                } else {
                    assert_eq!(
                        retained.availability,
                        crate::RetainedBuildAvailability::Verified
                    );
                    assert_eq!(retained.install.unwrap().id, installed.id);
                    assert!(retained.gap.is_none());
                    let preview = reopened
                        .preview_retained_build_binding(ID, pending_setup_id, &installed.id)
                        .unwrap();
                    assert_eq!(preview.build, reference.build);
                }
                assert_eq!(count(&library, "retained_build_references"), 1);
                assert_eq!(
                    reopened
                        .resolve_retained_build(ID, pending_setup_id)
                        .unwrap_err()
                        .code,
                    crate::ErrorCode::NotFound
                );
                assert_eq!(
                    crate::library_transfer::reviewed_tree(&installed.path).unwrap(),
                    original_tree
                );
                assert_eq!(fs::read(&cached).unwrap(), bytes);
                assert_eq!(server.requests.lock().unwrap().len(), before_references);
                let mut current_scope = policy::acquisition_scope(&library, &current_catalog, ID)
                    .unwrap()
                    .unwrap();
                current_scope.fixture_origin = Some(server.origin.clone());
                current_scope.require_current().unwrap();
                phase("fresh scope complete; acquisition refusal begin");
                let before = server.requests.lock().unwrap().len();
                let refusal = provider
                    .resolve_scoped(
                        current_catalog.port(ID).unwrap(),
                        ReleaseChannel::Stable,
                        platform,
                        Some(&current_scope),
                    )
                    .await
                    .unwrap_err();
                assert!(refusal.message.contains(if status == "revoked" {
                    "revoked"
                } else {
                    "distribution"
                }));
                phase("fresh acquisition refused; cache refusal begin");
                assert_eq!(server.requests.lock().unwrap().len(), before);
                let destination = library.root().join("held-cache-copy.zip");
                let refusal = crate::curated_cache::CacheWorker::new(
                    &current_scope,
                    &resolved.release.asset,
                    &crate::operation::OperationCoordinator::new("install", None),
                )
                .restore(&destination)
                .await
                .unwrap_err();
                phase("cache refused; final preservation begin");
                assert!(refusal.message.contains(if status == "revoked" {
                    "revoked"
                } else {
                    "distribution"
                }));
                assert!(!destination.exists());
                // Releasing a held reference is an explicit metadata-only action;
                // it must remain available without deleting the installed bytes.
                let removal = reopened
                    .preview_retained_build_removal(ID, setup_id)
                    .unwrap();
                assert_eq!(removal.reference, reference);
                let authorization = reopened
                    .authorize_retained_build_removal(ID, setup_id, &removal.preview_sha256)
                    .unwrap();
                let removed = reopened
                    .remove_retained_build_reference(ID, setup_id, &authorization.token)
                    .unwrap();
                assert_eq!(removed, reference);
                assert_eq!(count(&library, "retained_build_references"), 0);
                assert_eq!(
                    reopened
                        .resolve_retained_build(ID, setup_id)
                        .unwrap_err()
                        .code,
                    crate::ErrorCode::NotFound
                );
                assert!(installer.verify(&installed).unwrap().valid);
                assert_eq!(
                    crate::library_transfer::reviewed_tree(&installed.path).unwrap(),
                    original_tree
                );
                assert_eq!(fs::read(cached).unwrap(), bytes);
                assert_eq!(count(&library, "installs"), 1);
                assert_eq!(count(&library, "curated_artifact_admissions"), 1);
                assert_eq!(count(&library, "curated_transition_receipts"), 1);
                assert!(server.responses.lock().unwrap().is_empty());
                phase("installed final preservation complete");
                return;
            }
            if !cache_controls {
                continue;
            }
            phase("cache lock refusal begin");
            let guard = library.try_lock_curated_cache().unwrap();
            let blocked = library.root().join("busy-cache-copy.zip");
            assert!(
                !crate::curated_cache::CacheWorker::new(
                    &scope,
                    &resolved.release.asset,
                    &crate::operation::OperationCoordinator::new("install", None)
                )
                .restore(&blocked)
                .await
                .unwrap()
            );
            assert!(!blocked.exists());
            drop(guard);
            phase("cache lock refusal complete");
            let cached = library
                .downloads_dir()
                .join("curated-v1")
                .join(format!("{}.asset", record.sha256));
            let mut corrupted = bytes.clone();
            corrupted[0] ^= 1;
            std::fs::write(&cached, &corrupted).unwrap();
            phase("corrupted cache restore begin");
            let refusal = crate::curated_cache::CacheWorker::new(
                &scope,
                &resolved.release.asset,
                &crate::operation::OperationCoordinator::new("install", None),
            )
            .restore(&library.root().join("refused-cache-copy.zip"))
            .await
            .unwrap_err();
            assert!(refusal.message.contains("SHA-256"));
            assert_eq!(
                std::fs::read(&cached).unwrap(),
                corrupted,
                "failed cache evidence must remain"
            );
            phase("corrupted cache restore complete");
            phase("installed verification after corruption begin");
            assert!(installer.verify(&installed).unwrap().valid);
            phase("installed verification after corruption complete");
            phase("capacity fixture creation begin");
            let root = library.downloads_dir().join("curated-v1");
            std::fs::rename(
                &root,
                library.downloads_dir().join("curated-failed-fixture"),
            )
            .unwrap();
            std::fs::create_dir(&root).unwrap();
            for number in 0..256 {
                std::fs::write(root.join(format!("{number:064x}.asset")), []).unwrap();
            }
            phase("capacity fixture creation complete");
            let original = library.root().join("capacity-source.zip");
            std::fs::write(&original, &bytes).unwrap();
            phase("capacity retention refusal begin");
            assert!(
                !crate::curated_cache::CacheWorker::new(
                    &scope,
                    &resolved.release.asset,
                    &crate::operation::OperationCoordinator::new("install", None)
                )
                .retain(&original)
                .await
                .unwrap()
            );
            assert_eq!(
                std::fs::read_dir(&root).unwrap().count(),
                256,
                "a full cache must not evict evidence"
            );
            phase("capacity retention refusal complete");
        }
        phase(&format!("iteration {iteration} complete"));
    }
    if cache_controls {
        assert!(server.responses.lock().unwrap().is_empty());
        return;
    }
    let before = server.requests.lock().unwrap().len();
    server.json(serde_json::json!({"id":scope.repository_id,"archived":false}));
    let mut changed = release.clone();
    changed[0]["assets"][0]["id"] = (record.asset_id + 1).into();
    server.json(changed);
    assert!(
        provider
            .resolve_scoped(
                catalog.port(ID).unwrap(),
                ReleaseChannel::Stable,
                record.platform,
                Some(&scope)
            )
            .await
            .is_err()
    );
    assert_eq!(server.requests.lock().unwrap().len(), before + 2);
    server.json(serde_json::json!({"id":scope.repository_id,"archived":false}));
    server.json(release);
    let mut changed = tag;
    changed["object"]["sha"] = "d".repeat(40).into();
    server.json(changed);
    assert!(
        provider
            .resolve_scoped(
                catalog.port(ID).unwrap(),
                ReleaseChannel::Stable,
                record.platform,
                Some(&scope)
            )
            .await
            .is_err()
    );
    assert!(server.responses.lock().unwrap().is_empty());
    // Even a newly authenticated independent policy cannot silently repin an
    // already admitted immutable GitHub asset. The entire policy write rolls
    // back, preserving the earlier scope and accepted installation.
    let mut repinned = catalog.authoritative_document();
    repinned
        .ports
        .iter_mut()
        .find(|port| port.id == ID)
        .unwrap()
        .release
        .curated
        .get_mut(&record.platform)
        .unwrap()
        .sha256 = "d".repeat(64);
    phase("repin publication begin");
    let repinned = Catalog::from_json(&serde_json::to_string(&repinned).unwrap()).unwrap();
    let mut targets = repository_targets_for(&repinned, ID);
    let mut document = managed_policy_for(&targets, true);
    document["policy_schema"] = 4.into();
    document["policy_revision"] = 2.into();
    document["decision"]["curated_acquisition_checks"] = 1.into();
    targets.push((
        format!("policy/official/{ID}.json"),
        serde_json::to_vec(&document).unwrap(),
    ));
    fixture
        .publish_with_policy(
            &targets,
            true,
            &DEFINITION_ROLE_PATHS,
            later(),
            Some((&key, 2)),
        )
        .await;
    let candidate = acquire(&fixture, &root).await.unwrap();
    let admission = acquire_policy(&fixture, &root, ID).await.unwrap();
    let refusal = library
        .apply_definition_publisher_policy(&admission, Some(&candidate))
        .unwrap_err();
    assert!(refusal.message.contains("previously accepted bytes"));
    scope.require_current().unwrap();
    assert_eq!(count(&library, "curated_artifact_admissions"), 1);
    assert_eq!(count(&library, "installs"), 1);
    let original_policy: String = library
        .connection()
        .unwrap()
        .query_row(
            "SELECT policy_json FROM definition_publisher_admission WHERE stable_id=?1",
            [ID],
            |row| row.get(0),
        )
        .unwrap();
    let connection = library.connection().unwrap();
    let protected_delete = connection
        .execute("DELETE FROM curated_artifact_admissions", [])
        .unwrap_err();
    assert!(protected_delete.to_string().contains("FOREIGN KEY"));
    // Simulate loss of both membership and immutable identity without disabling
    // the production foreign key. Retained counters must still refuse renewal.
    connection
        .execute_batch(
            "BEGIN IMMEDIATE;
             DELETE FROM curated_artifact_scopes;
             DELETE FROM curated_artifact_admissions;
             COMMIT;",
        )
        .unwrap();
    drop(connection);
    assert!(scope.require_port(catalog.port(ID).unwrap()).is_err());
    for (policy, candidate) in [
        (&original_admission, &original_candidate),
        (&admission, &candidate),
    ] {
        let refusal = library
            .apply_definition_publisher_policy(policy, Some(candidate))
            .unwrap_err();
        assert!(
            refusal.message.contains("history is incomplete"),
            "{}",
            refusal.message
        );
    }
    let retained_policy: String = library
        .connection()
        .unwrap()
        .query_row(
            "SELECT policy_json FROM definition_publisher_admission WHERE stable_id=?1",
            [ID],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(retained_policy, original_policy);
    assert_eq!(count(&library, "curated_artifact_admissions"), 0);
    let installs = library.all_installs().unwrap();
    assert_eq!(installs.len(), 1);
    assert!(
        crate::Installer::new(library.clone())
            .unwrap()
            .verify(&installs[0])
            .unwrap()
            .valid
    );
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
    // Build the actual schema-33 history forward and project its supported
    // signed admission, installation and library state into that fresh database.
    assert_eq!(count(&library, "definition_launch_assessments"), 0);
    assert_eq!(count(&library, "definition_launch_decisions"), 0);
    assert_eq!(count(&library, "curated_artifact_scopes"), 0);
    assert_eq!(count(&library, "curated_artifact_admissions"), 0);
    assert_eq!(count(&library, "curated_transition_receipts"), 0);
    assert_eq!(count(&library, "ghostship_legacy_qualifications"), 0);
    assert_eq!(count(&library, "ghostship_qualified_backups"), 0);
    assert_eq!(count(&library, "ghostship_runtime_safety"), 0);
    assert_eq!(count(&library, "retained_build_references"), 0);
    assert_eq!(
        library
            .connection()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM lifecycle_operations
             WHERE ghostship_recovery_json IS NOT NULL OR backup_deletion_json IS NOT NULL",
                [],
                |row| row.get::<_, u64>(0),
            )
            .unwrap(),
        0,
    );
    crate::database::recreate_schema_33_fixture(library.root()).unwrap();
    let historical_root = library.root().to_path_buf();
    assert!(
        Library::open(&historical_root).is_err(),
        "migration must respect live library users"
    );
    drop(installer);
    drop(scope);
    drop(library);
    let upgraded = Library::open(&historical_root).unwrap();
    assert_eq!(
        serde_json::to_value(upgraded.all_installs().unwrap()).unwrap(),
        serde_json::to_value(&delivered).unwrap()
    );
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
    assert_eq!(count(&upgraded, "retained_build_references"), 0);
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
    candidate: Option<crate::AuthenticatedDefinitionCandidate>,
    point: crate::operation::LifecycleFaultPoint,
    interrupt: bool,
    withdrawals: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}
impl crate::operation::LifecycleFaultInjector for WithdrawPreparation {
    fn check(&self, point: crate::operation::LifecycleFaultPoint) -> crate::Result<()> {
        if point == self.point {
            self.library
                .apply_definition_publisher_policy(&self.withdrawal, self.candidate.as_ref())?;
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
    install_managed_preparation_fixture_with_probe(directory, library, catalog, source_bytes, None)
}

fn install_managed_preparation_fixture_with_probe(
    directory: &TempDir,
    library: &Library,
    catalog: &Catalog,
    source_bytes: &[u8],
    exact_probe: Option<&std::path::Path>,
) -> (crate::InstallRecord, std::path::PathBuf) {
    let platform = crate::Platform::current().unwrap();
    let port = catalog.port(ID).unwrap();
    let artifact = port.release.curated.get(&platform).map_or_else(
        || crate::ArtifactIdentity {
            asset_name: "fixture.zip".into(),
            sha256: hex::encode(Sha256::digest(b"owned source artifact")),
            size: 1,
        },
        |record| crate::ArtifactIdentity {
            asset_name: record.filename.clone(),
            sha256: record.sha256.clone(),
            size: record.size,
        },
    );
    let install_root = library.versions_dir().join(ID).join(&artifact.sha256);
    fs::create_dir_all(&install_root).unwrap();
    let probe_root = directory.path().join("owned-probe");
    fs::create_dir(&probe_root).unwrap();
    let executable = install_root.join(&port.executable_hints[&platform][0]);
    let probe = exact_probe
        .map(std::path::Path::to_path_buf)
        .unwrap_or_else(|| crate::test_fixture::build_probe(&probe_root));
    fs::copy(&probe, &executable).unwrap();
    assert_eq!(fs::read(&executable).unwrap(), fs::read(&probe).unwrap());
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

async fn curated_preparation_fixture(
    status: &str,
    interrupted: Option<crate::operation::LifecycleFaultPoint>,
) {
    use crate::operation::{LifecycleFaultPoint, LifecyclePhase, OperationStore};
    use std::io::{Cursor, Write};
    let source_bytes: &[u8] = &[0x80, 0x37, 0x12, 0x40, 0, 0, 0, 0];
    let platform = crate::Platform::current().unwrap();
    let probe_directory = TempDir::new().unwrap();
    let probe = crate::test_fixture::build_probe(probe_directory.path());
    let mut document = managed_preparation_catalog(source_bytes).authoritative_document();
    let port = document
        .ports
        .iter_mut()
        .find(|port| port.id == ID)
        .unwrap();
    let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
    archive
        .start_file(
            &port.executable_hints[&platform][0],
            zip::write::SimpleFileOptions::default().unix_permissions(0o755),
        )
        .unwrap();
    archive.write_all(&fs::read(&probe).unwrap()).unwrap();
    let bytes = archive.finish().unwrap().into_inner();
    let mut record = crate::curated_acquisition::fixture_record();
    record.repository = port.release.repository.clone();
    record.upstream_url = format!("https://github.com/{}", record.repository);
    record.platform = platform;
    record.tag = "v1".into();
    record.filename = format!("game-{}.zip", platform.asset_tokens()[0]);
    record.size = bytes.len() as u64;
    record.sha256 = hex::encode(Sha256::digest(&bytes));
    record.acquisition_url = format!(
        "{}/releases/download/{}/{}",
        record.upstream_url, record.tag, record.filename
    );
    port.release.curated.insert(platform, record.clone());
    let authored = Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap();
    let (fixture, key, root, directory, library, mut catalog, _) =
        managed_fixture_for_policy(authored, true).await;
    let user = library.user_dir(ID);
    fs::create_dir_all(user.join("saves")).unwrap();
    fs::write(
        user.join("saves/progress.bin"),
        b"owned preparation progress",
    )
    .unwrap();
    let user_tree = crate::library_transfer::reviewed_tree(&user).unwrap();
    let transitions = serde_json::json!({"future_acceptance_lost":false,"artifacts":[{"asset_id":record.asset_id,"sha256":record.sha256,"status":status}]});
    let (candidate, admission) =
        publish_curated_transition(&fixture, &key, &root, &catalog, 2, Some(transitions)).await;
    if status == "distribution_withdrawn" || interrupted.is_none() {
        library
            .apply_definition_publisher_policy(&admission, Some(&candidate))
            .unwrap();
        let eligible = library
            .assess_definition_candidate(&candidate, "official", ID)
            .unwrap()
            .into_eligible()
            .unwrap();
        library.select_definition_candidate(eligible).unwrap();
        catalog = crate::definition_candidate::selection::load_selected_definition_catalog(
            &library.connection().unwrap(),
            &catalog,
            now_unix(),
        )
        .unwrap()
        .unwrap()
        .0;
    }
    // Withdrawal does not waive the existing policy-revision guard. Its positive
    // control retains the current reviewed contract, while revocation is applied
    // to an already prepared original at the selected interruption boundary.
    let (original, source) = install_managed_preparation_fixture_with_probe(
        &directory,
        &library,
        &catalog,
        source_bytes,
        Some(&probe),
    );
    let original_tree = crate::library_transfer::reviewed_tree(&original.path).unwrap();
    let hits = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let mut service = if let Some(point) = interrupted {
        PortcoveService::with_faults(
            library.clone(),
            std::sync::Arc::new(WithdrawPreparation {
                library: library.clone(),
                withdrawal: admission,
                candidate: Some(candidate),
                point,
                interrupt: true,
                withdrawals: hits.clone(),
            }),
        )
        .unwrap()
    } else {
        PortcoveService::new(library.clone()).unwrap()
    };
    service.replace_catalog_for_test(catalog.clone());
    let options = crate::PreparationOptions {
        target: platform,
        mode: crate::PreparationMode::Default,
    };
    let store = OperationStore::new(library.clone());
    if interrupted.is_none() && status == "revoked" {
        assert!(
            service
                .plan_preparation(ID, options)
                .unwrap_err()
                .message
                .contains("revoked")
        );
        assert!(store.all().unwrap().is_empty());
        assert_eq!(count(&library, "installs"), 1);
    } else {
        let plan = service.plan_preparation(ID, options).unwrap();
        let authorization = service
            .authorize_preparation(ID, options, &plan.plan_sha256)
            .unwrap();
        let prepared = service.prepare(ID, options, &authorization.token, |_| {});
        if let Some(point) = interrupted {
            let error = prepared.unwrap_err();
            assert!(
                error
                    .message
                    .contains("owned managed preparation interruption"),
                "unexpected preparation error: {error:?}"
            );
            assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 1);
            let journal = store.all().unwrap().remove(0);
            let expected_phase = if point == LifecycleFaultPoint::PreparationPrepared {
                LifecyclePhase::Prepared
            } else {
                LifecyclePhase::PayloadPublished
            };
            assert_eq!(journal.phase, expected_phase);
            let install = journal.install.as_ref().unwrap();
            let payload = journal.paths.staging.as_ref().unwrap().join("payload");
            let retained_path = if expected_phase == LifecyclePhase::Prepared {
                &payload
            } else {
                &install.path
            };
            let retained_tree = crate::library_transfer::reviewed_tree(retained_path).unwrap();
            drop(service);
            for _ in 0..2 {
                let _reopened = PortcoveService::new(library.clone()).unwrap();
                if status == "revoked" {
                    let held = store.get(&journal.id).unwrap().unwrap();
                    assert_eq!(held.phase, expected_phase);
                    assert!(held.last_error.unwrap().contains("revoked"));
                    assert_eq!(count(&library, "installs"), 1);
                    assert_eq!(
                        library
                            .status(ID, ReleaseChannel::Stable)
                            .unwrap()
                            .active
                            .unwrap()
                            .id,
                        original.id
                    );
                    assert_eq!(
                        crate::library_transfer::reviewed_tree(retained_path).unwrap(),
                        retained_tree
                    );
                    assert_eq!(
                        install.path.exists(),
                        expected_phase == LifecyclePhase::PayloadPublished
                    );
                } else {
                    assert!(store.get(&journal.id).unwrap().is_none());
                    assert_eq!(count(&library, "installs"), 2);
                    assert_eq!(
                        library
                            .status(ID, ReleaseChannel::Stable)
                            .unwrap()
                            .active
                            .unwrap()
                            .id,
                        install.id
                    );
                    assert_eq!(
                        crate::library_transfer::reviewed_tree(&install.path).unwrap(),
                        retained_tree
                    );
                    assert!(!journal.paths.staging.as_ref().unwrap().exists());
                }
            }
        } else {
            let prepared = prepared.unwrap();
            assert_ne!(prepared.id, original.id);
            assert!(prepared.path.join("prepared.marker").is_file());
            assert!(store.all().unwrap().is_empty());
            assert_eq!(count(&library, "installs"), 2);
        }
    }
    assert_eq!(fs::read(&source).unwrap(), source_bytes);
    assert_eq!(
        crate::library_transfer::reviewed_tree(&original.path).unwrap(),
        original_tree
    );
    assert_eq!(
        crate::library_transfer::reviewed_tree(&user).unwrap(),
        user_tree
    );
    assert_eq!(count(&library, "curated_artifact_admissions"), 1);
    assert_eq!(count(&library, "curated_transition_receipts"), 1);
}

#[tokio::test]
async fn curated_preparation_revocation_refuses_before_setup() {
    curated_preparation_fixture("revoked", None).await;
}
#[tokio::test]
async fn curated_preparation_withdrawal_permits_owned_setup() {
    curated_preparation_fixture("distribution_withdrawn", None).await;
}
#[tokio::test]
async fn curated_preparation_prepared_revocation_retains_journal() {
    curated_preparation_fixture(
        "revoked",
        Some(crate::operation::LifecycleFaultPoint::PreparationPrepared),
    )
    .await;
}
#[tokio::test]
async fn curated_preparation_published_revocation_retains_journal() {
    curated_preparation_fixture(
        "revoked",
        Some(crate::operation::LifecycleFaultPoint::PreparationPublished),
    )
    .await;
}
#[tokio::test]
async fn curated_preparation_prepared_withdrawal_recovers_once() {
    curated_preparation_fixture(
        "distribution_withdrawn",
        Some(crate::operation::LifecycleFaultPoint::PreparationPrepared),
    )
    .await;
}
#[tokio::test]
async fn curated_preparation_published_withdrawal_recovers_once() {
    curated_preparation_fixture(
        "distribution_withdrawn",
        Some(crate::operation::LifecycleFaultPoint::PreparationPublished),
    )
    .await;
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
            candidate: None,
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

#[path = "listing_delivery_tests.rs"]
mod descriptive_listing_delivery;
