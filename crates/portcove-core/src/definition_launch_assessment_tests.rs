//! Controlled independent-policy fixtures, not production publishing or gameplay.
use super::*;
use policy::launch_assessment as launch;

fn assessment_document(policy_sha256: &str, revision: u64, assessments: Vec<Value>) -> Value {
    serde_json::json!({
        "assessment_schema":1, "namespace":"official", "stable_id":ID,
        "policy_sha256":policy_sha256, "revision":revision, "assessments":assessments,
    })
}

fn held(record: &crate::InstallRecord, check_id: &str, revision: u64) -> Value {
    serde_json::json!({
        "subject": {
            "version":record.version, "channel":record.channel,
            "platform":crate::Platform::current().unwrap(),
            "artifact":record.artifact, "operation":"launch",
        },
        "check_id":check_id, "check_input_sha256":"a".repeat(64), "revision":revision,
        "decision":{"status":"held", "failure_sha256":"b".repeat(64)},
    })
}

async fn publish_assessment(
    fixture: &RepositoryFixture,
    key: &Key,
    root: &[u8],
    catalog: &Catalog,
    metadata_version: u64,
    document: &Value,
) -> crate::Result<crate::AuthenticatedDefinitionLaunchAssessment> {
    // Reconstruct the exact deterministic initial grant from the same authoring
    // input; publishing an assessment does not alter that grant's bytes.
    let mut targets = repository_targets_for(catalog, ID);
    let policy_bytes = serde_json::to_vec(&managed_policy_for(&targets, true)).unwrap();
    targets.push((format!("policy/official/{ID}.json"), policy_bytes));
    targets.push((
        format!("policy/official/{ID}.launch.json"),
        serde_json::to_vec(document).unwrap(),
    ));
    let current_root = fixture
        .publish_with_policy(
            &targets,
            true,
            &DEFINITION_ROLE_PATHS,
            later(),
            Some((key, metadata_version)),
        )
        .await;
    assert_eq!(&current_root, root);
    launch::acquire_with_transport(
        root,
        fixture.metadata_url(),
        fixture.targets_url(),
        FilesystemTransport,
        "official",
        ID,
    )
    .await
}

#[tokio::test]
async fn scoped_launch_policy_requires_explicit_supported_format() {
    let mut document = managed_github(1);
    document["policy_schema"] = 3.into();
    assert_signed_managed_policy_refused(document.clone()).await;
    document["decision"]["scoped_launch_checks"] = 2.into();
    assert_signed_managed_policy_refused(document.clone()).await;
    document["decision"]["scoped_launch_checks"] = 1.into();
    let fixture = RepositoryFixture::new();
    let key = Key::new(fixture._directory.path());
    let root = publish(&fixture, &key, 1, &document).await;
    assert!(acquire_policy(&fixture, &root, ID).await.is_ok());
    document["policy_schema"] = 2.into();
    assert_signed_managed_policy_refused(document.clone()).await;
    document["decision"]["scoped_launch_checks"] = Value::Null;
    assert_signed_managed_policy_refused(document).await;
}

// Supplied-subject controls qualify authenticated admission/eligibility. Actual
// verified installed-manifest/public-supervisor acceptance is a separate test.
fn record() -> crate::InstallRecord {
    crate::InstallRecord {
        id: "controlled-subject".into(),
        port_id: ID.into(),
        version: "v1".into(),
        path: std::path::PathBuf::from("unused-controlled-subject"),
        channel: ReleaseChannel::Stable,
        installed_at: Library::now(),
        verified: true,
        staged: false,
        artifact: crate::ArtifactIdentity {
            asset_name: "ordinary.zip".into(),
            sha256: "c".repeat(64),
            size: 42,
        },
        runtime: None,
        manifest_sha256: String::new(),
        selected_executable: std::path::PathBuf::from("unused"),
    }
}

fn launch_context(
    record: &crate::InstallRecord,
    platform: crate::Platform,
) -> DefinitionOperationContext {
    let mut context = DefinitionOperationContext::observed(DefinitionOperation::Launch, true, true);
    context.launch_subject = Some(launch::verified_subject_key(record, platform).unwrap());
    context
}

#[tokio::test]
async fn scoped_launch_decisions_require_exact_correction_and_preserve_other_checks() {
    let authored = metadata_catalog();
    let (fixture, key, root, _directory, library, catalog, scope) =
        managed_fixture_for_policy(authored.clone(), true).await;
    let identity = catalog.definition_selection(ID).unwrap();
    let record = record();
    let context = launch_context(&record, crate::Platform::current().unwrap());
    assert_eq!(
        library
            .assess_definition_operation(identity, context)
            .unwrap()
            .reason,
        DefinitionEligibilityReason::UnknownSafetySemantics
    );
    let baseline = assessment_document(&scope.policy_sha256, 1, vec![]);
    let accepted = publish_assessment(&fixture, &key, &root, &authored, 2, &baseline)
        .await
        .unwrap();
    assert!(
        library
            .apply_definition_launch_assessment(&accepted)
            .unwrap()
    );
    assert!(
        !library
            .apply_definition_launch_assessment(&accepted)
            .unwrap()
    );
    assert_eq!(
        library
            .assess_definition_operation(identity, context)
            .unwrap()
            .outcome,
        DefinitionEligibilityOutcome::Eligible
    );
    let first = held(&record, "launch-integrity", 2);
    let second = held(&record, "launch-compatibility", 2);
    let failure = assessment_document(&scope.policy_sha256, 2, vec![first.clone(), second.clone()]);
    let accepted = publish_assessment(&fixture, &key, &root, &authored, 3, &failure)
        .await
        .unwrap();
    let decisions = accepted.decision_sha256s().unwrap();
    library
        .apply_definition_launch_assessment(&accepted)
        .unwrap();
    assert_eq!(
        library
            .assess_definition_operation(identity, context)
            .unwrap()
            .reason,
        DefinitionEligibilityReason::MandatoryCheckFailed
    );
    let mut unaffected = record.clone();
    unaffected.version = "v2".into();
    unaffected.artifact.sha256 = "d".repeat(64);
    let other_platform = if crate::Platform::current().unwrap() == crate::Platform::WindowsX86_64 {
        crate::Platform::LinuxX86_64
    } else {
        crate::Platform::WindowsX86_64
    };
    for unaffected_context in [
        launch_context(&unaffected, crate::Platform::current().unwrap()),
        launch_context(&record, other_platform),
        DefinitionOperationContext::observed(DefinitionOperation::Install, false, true),
    ] {
        assert_eq!(
            library
                .assess_definition_operation(identity, unaffected_context)
                .unwrap()
                .outcome,
            DefinitionEligibilityOutcome::Eligible
        );
    }
    let omission = assessment_document(&scope.policy_sha256, 3, vec![]);
    let accepted = publish_assessment(&fixture, &key, &root, &authored, 4, &omission)
        .await
        .unwrap();
    library
        .apply_definition_launch_assessment(&accepted)
        .unwrap();
    assert_eq!(
        library
            .assess_definition_operation(identity, context)
            .unwrap()
            .reason,
        DefinitionEligibilityReason::MandatoryCheckFailed
    );
    for (index, mut corrected) in [first, second].into_iter().enumerate() {
        corrected["revision"] = (index + 4).into();
        corrected["decision"] = serde_json::json!({"status":"cleared",
            "previous_decision_sha256":decisions[index], "correction_sha256":"e".repeat(64)});
        let document =
            assessment_document(&scope.policy_sha256, (index + 4) as u64, vec![corrected]);
        let accepted = publish_assessment(
            &fixture,
            &key,
            &root,
            &authored,
            (index + 5) as u64,
            &document,
        )
        .await
        .unwrap();
        library
            .apply_definition_launch_assessment(&accepted)
            .unwrap();
        assert_eq!(
            library
                .assess_definition_operation(identity, context)
                .unwrap()
                .outcome,
            if index == 0 {
                DefinitionEligibilityOutcome::Hold
            } else {
                DefinitionEligibilityOutcome::Eligible
            }
        );
    }
    // Neither admission nor correction rewrites the exact immutable grant.
    assert_eq!(
        policy::acquisition_scope(&library, &catalog, ID)
            .unwrap()
            .unwrap()
            .policy_sha256,
        scope.policy_sha256
    );
}

#[tokio::test]
async fn scoped_launch_missing_baseline_cannot_reset_empty_or_populated_floor() {
    for populated in [false, true] {
        let authored = metadata_catalog();
        let (fixture, key, root, directory, library, catalog, scope) =
            managed_fixture_for_policy(authored.clone(), true).await;
        let decision = held(&record(), "launch-integrity", 7);
        let baseline = assessment_document(
            &scope.policy_sha256,
            7,
            if populated { vec![decision] } else { vec![] },
        );
        let accepted = publish_assessment(&fixture, &key, &root, &authored, 2, &baseline)
            .await
            .unwrap();
        library
            .apply_definition_launch_assessment(&accepted)
            .unwrap();
        library.connection().unwrap().execute_batch(
            "DELETE FROM definition_launch_assessments; DELETE FROM definition_launch_decisions;").unwrap();
        let identity = catalog.definition_selection(ID).unwrap().clone();
        let policy_sha256 = scope.policy_sha256.clone();
        drop(catalog);
        drop(scope);
        drop(library);
        let reopened = Library::open(directory.path()).unwrap();
        let baseline = assessment_document(&policy_sha256, 1, vec![]);
        let replay = publish_assessment(&fixture, &key, &root, &authored, 3, &baseline)
            .await
            .unwrap();
        assert!(
            reopened
                .apply_definition_launch_assessment(&replay)
                .is_err()
        );
        assert!(
            reopened
                .assess_definition_operation(
                    &identity,
                    launch_context(&record(), crate::Platform::current().unwrap())
                )
                .is_err()
        );
    }
}

#[tokio::test]
async fn scoped_launch_initialized_grant_refuses_downgrade_and_lost_admission_recreation() {
    for delete_admission in [false, true] {
        let authored = metadata_catalog();
        let (fixture, key, root, _directory, library, _catalog, scope) =
            managed_fixture_for_policy(authored.clone(), true).await;
        let failure = assessment_document(
            &scope.policy_sha256,
            1,
            vec![held(&record(), "launch-integrity", 1)],
        );
        let accepted = publish_assessment(&fixture, &key, &root, &authored, 2, &failure)
            .await
            .unwrap();
        library
            .apply_definition_launch_assessment(&accepted)
            .unwrap();
        let mut targets = repository_targets_for(&authored, ID);
        let mut changed = managed_policy_for(&targets, delete_admission);
        changed["policy_revision"] = 2.into();
        targets.push((
            format!("policy/official/{ID}.json"),
            serde_json::to_vec(&changed).unwrap(),
        ));
        fixture
            .publish_with_policy(
                &targets,
                true,
                &DEFINITION_ROLE_PATHS,
                later(),
                Some((&key, 3)),
            )
            .await;
        let candidate = acquire(&fixture, &root).await.unwrap();
        let changed = acquire_policy(&fixture, &root, ID).await.unwrap();
        if delete_admission {
            library
                .connection()
                .unwrap()
                .execute_batch("DELETE FROM definition_publisher_admission;")
                .unwrap();
        }
        assert!(
            library
                .apply_definition_publisher_policy(&changed, Some(&candidate))
                .is_err()
        );
        assert_eq!(count(&library, "definition_launch_decisions"), 1);
        let retained_revision: i64 = library
            .connection()
            .unwrap()
            .query_row(
                "SELECT policy_revision FROM definition_publisher_policy WHERE stable_id=?1",
                [ID],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(retained_revision, 1);
    }
}

#[tokio::test]
async fn scoped_launch_refusals_preserve_prior_hold_and_atomic_state() {
    let authored = metadata_catalog();
    let (fixture, key, root, _directory, library, catalog, scope) =
        managed_fixture_for_policy(authored.clone(), true).await;
    let failure = held(&record(), "launch-integrity", 4);
    let document = assessment_document(&scope.policy_sha256, 4, vec![failure.clone()]);
    let accepted = publish_assessment(&fixture, &key, &root, &authored, 2, &document)
        .await
        .unwrap();
    library
        .apply_definition_launch_assessment(&accepted)
        .unwrap();
    let identity = catalog.definition_selection(ID).unwrap();
    let context = launch_context(&record(), crate::Platform::current().unwrap());
    let mut cases = Vec::new();
    cases.push(assessment_document(&scope.policy_sha256, 3, vec![]));
    let mut equivocation = document.clone();
    equivocation["assessments"] = serde_json::json!([]);
    cases.push(equivocation);
    let mut correction = failure.clone();
    correction["revision"] = 5.into();
    correction["decision"] = serde_json::json!({"status":"cleared",
        "previous_decision_sha256":"d".repeat(64), "correction_sha256":"e".repeat(64)});
    cases.push(assessment_document(
        &scope.policy_sha256,
        5,
        vec![correction],
    ));
    cases.push(assessment_document(&"e".repeat(64), 5, vec![]));
    for (index, bad) in cases.iter().enumerate() {
        let refused = publish_assessment(&fixture, &key, &root, &authored, (index + 3) as u64, bad)
            .await
            .unwrap();
        assert!(
            library
                .apply_definition_launch_assessment(&refused)
                .is_err()
        );
        assert_eq!(
            library
                .assess_definition_operation(identity, context)
                .unwrap()
                .reason,
            DefinitionEligibilityReason::MandatoryCheckFailed
        );
    }
    // Deterministic transaction failure after payload writes but before the
    // independent admission floor update must roll back the entire apply.
    library
        .connection()
        .unwrap()
        .execute_batch(
            "CREATE TRIGGER refuse_launch_floor
        BEFORE UPDATE OF launch_assessment_revision ON definition_publisher_admission
        BEGIN SELECT RAISE(ABORT,'controlled apply interruption'); END;",
        )
        .unwrap();
    let omission = assessment_document(&scope.policy_sha256, 5, vec![]);
    let interrupted = publish_assessment(&fixture, &key, &root, &authored, 7, &omission)
        .await
        .unwrap();
    assert!(
        library
            .apply_definition_launch_assessment(&interrupted)
            .is_err()
    );
    assert_eq!(
        library
            .assess_definition_operation(identity, context)
            .unwrap()
            .reason,
        DefinitionEligibilityReason::MandatoryCheckFailed
    );
    let revision: i64 = library.connection().unwrap().query_row(
        "SELECT launch_assessment_revision FROM definition_publisher_admission WHERE stable_id=?1", [ID],
        |row| row.get(0)).unwrap();
    assert_eq!(revision, 4);
}
