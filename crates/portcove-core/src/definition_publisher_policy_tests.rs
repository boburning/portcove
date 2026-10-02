use super::super::publisher_policy as policy;
use super::*;

const ID: &str = "tuf-metadata-fixture";

fn availability(revision: u64) -> Value {
    let targets = metadata_targets();
    availability_for(&targets, ID, revision)
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
