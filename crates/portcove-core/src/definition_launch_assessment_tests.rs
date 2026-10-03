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
async fn scoped_launch_revocation_is_typed_and_regrant_preserves_hold() {
    let authored = metadata_catalog();
    let (fixture, key, root, _directory, library, catalog, scope) =
        managed_fixture_for_policy(authored.clone(), true).await;
    let document = assessment_document(
        &scope.policy_sha256,
        1,
        vec![held(&record(), "launch-integrity", 1)],
    );
    let accepted = publish_assessment(&fixture, &key, &root, &authored, 2, &document)
        .await
        .unwrap();
    library
        .apply_definition_launch_assessment(&accepted)
        .unwrap();
    let identity = catalog.definition_selection(ID).unwrap();
    let context = launch_context(&record(), crate::Platform::current().unwrap());
    let mut targets = repository_targets_for(&authored, ID);
    let mut revoked = managed_policy_for(&targets, true);
    revoked["policy_schema"] = 2.into();
    revoked["policy_revision"] = 2.into();
    revoked["decision"] = serde_json::json!({"status":"revoked"});
    targets.push((
        format!("policy/official/{ID}.json"),
        serde_json::to_vec(&revoked).unwrap(),
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
    let revoked = acquire_policy(&fixture, &root, ID).await.unwrap();
    library
        .apply_definition_publisher_policy(&revoked, None)
        .unwrap();
    assert_eq!(
        library
            .assess_definition_operation(identity, context)
            .unwrap()
            .reason,
        DefinitionEligibilityReason::PublisherRevoked
    );
    assert_eq!(count(&library, "definition_launch_decisions"), 1);

    let mut targets = repository_targets_for(&authored, ID);
    let mut regrant = managed_policy_for(&targets, true);
    regrant["policy_revision"] = 3.into();
    let bytes = serde_json::to_vec(&regrant).unwrap();
    let policy_sha256 = hex::encode(Sha256::digest(&bytes));
    let baseline = assessment_document(&policy_sha256, 2, vec![]);
    targets.push((format!("policy/official/{ID}.json"), bytes));
    targets.push((
        format!("policy/official/{ID}.launch.json"),
        serde_json::to_vec(&baseline).unwrap(),
    ));
    fixture
        .publish_with_policy(
            &targets,
            true,
            &DEFINITION_ROLE_PATHS,
            later(),
            Some((&key, 4)),
        )
        .await;
    let candidate = acquire(&fixture, &root).await.unwrap();
    let regrant = acquire_policy(&fixture, &root, ID).await.unwrap();
    library
        .apply_definition_publisher_policy(&regrant, Some(&candidate))
        .unwrap();
    let accepted = launch::acquire_with_transport(
        &root,
        fixture.metadata_url(),
        fixture.targets_url(),
        FilesystemTransport,
        "official",
        ID,
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
            .reason,
        DefinitionEligibilityReason::RecordedIdentityChanged
    );
    assert_eq!(
        launch::checks_passed(&library.connection().unwrap(), identity, context).unwrap(),
        Some(false)
    );
    assert_eq!(count(&library, "definition_launch_decisions"), 1);
}

#[tokio::test]
async fn scoped_launch_verified_ordinary_artifact_hold_correction_and_next_release() {
    use crate::ReleaseProvider;
    use std::io::{Cursor, Write};
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
    let (fixture, key, root, directory, library, catalog, mut scope) =
        managed_fixture_for_policy(authored.clone(), true).await;
    let probe = crate::test_fixture::build_probe(directory.path());
    let payload = fs::read(probe).unwrap();
    let server = AcquisitionHttp::new();
    scope.fixture_origin = Some(server.origin.clone());
    let installer = crate::Installer::new(library.clone()).unwrap();
    let mut delivered = Vec::new();
    for version in ["v1", "v2"] {
        let provider = crate::GithubReleaseProvider::with_api_root(server.origin.clone()).unwrap();
        let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
        archive
            .start_file(
                executable,
                zip::write::SimpleFileOptions::default().unix_permissions(0o755),
            )
            .unwrap();
        archive.write_all(&payload).unwrap();
        // Ordinary release content differs while retaining the same capable
        // native executable; artifact storage deliberately keys exact bytes.
        archive
            .start_file("release.txt", zip::write::SimpleFileOptions::default())
            .unwrap();
        archive.write_all(version.as_bytes()).unwrap();
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
        assert_eq!(
            crate::install::verified_launch_subject(&installed).unwrap(),
            launch::verified_subject_key(&installed, platform).unwrap()
        );
        delivered.push(installed);
    }
    let failure = held(&delivered[0], "launch-integrity", 1);
    let document = assessment_document(&scope.policy_sha256, 1, vec![failure.clone()]);
    let accepted = publish_assessment(&fixture, &key, &root, &authored, 2, &document)
        .await
        .unwrap();
    let failure_sha = accepted.decision_sha256s().unwrap().remove(0);
    library
        .apply_definition_launch_assessment(&accepted)
        .unwrap();
    let service = PortcoveService::new(library.clone()).unwrap();
    // The ordinary next artifact is unaffected by an exact earlier-release hold.
    let status = service.status(ID).unwrap();
    assert_eq!(status.active.as_ref().unwrap().id, delivered[1].id);
    assert_eq!(
        status
            .definition_operations
            .iter()
            .find(|a| a.operation == DefinitionOperation::Launch)
            .unwrap()
            .eligibility
            .outcome,
        DefinitionEligibilityOutcome::Eligible
    );
    let release = directory.path().join("next-release-exit");
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
            |_| fs::write(&release, b"released").unwrap(),
        )
        .unwrap();
    assert!(outcome.successful);
    assert_eq!(outcome.exit_code, Some(0));
    library.register_install(&delivered[0], true).unwrap();
    let service = PortcoveService::new(library.clone()).unwrap();
    let status = service.status(ID).unwrap();
    assert_eq!(
        status
            .definition_operations
            .iter()
            .find(|a| a.operation == DefinitionOperation::Launch)
            .unwrap()
            .eligibility
            .reason,
        DefinitionEligibilityReason::MandatoryCheckFailed
    );
    let mut started = 0;
    assert!(
        service
            .supervise_launch(
                ID,
                None,
                &["--game".into()],
                crate::LaunchStdio::Null,
                |_| started += 1
            )
            .is_err()
    );
    assert_eq!(started, 0);
    let mut correction = failure;
    correction["revision"] = 2.into();
    correction["decision"] = serde_json::json!({"status":"cleared",
        "previous_decision_sha256":failure_sha, "correction_sha256":"e".repeat(64)});
    let document = assessment_document(&scope.policy_sha256, 2, vec![correction]);
    let accepted = publish_assessment(&fixture, &key, &root, &authored, 3, &document)
        .await
        .unwrap();
    library
        .apply_definition_launch_assessment(&accepted)
        .unwrap();
    let service = PortcoveService::new(library.clone()).unwrap();
    let release = directory.path().join("corrected-release-exit");
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
    assert_eq!(started, 1);
    assert_eq!(
        fs::read(delivered[0].path.join(executable)).unwrap(),
        payload
    );
    assert_eq!(
        fs::read(delivered[1].path.join(executable)).unwrap(),
        payload
    );
    assert_eq!(server.requests.lock().unwrap().len(), 6);
    assert!(server.responses.lock().unwrap().is_empty());
}

#[tokio::test]
async fn scoped_launch_admission_serializes_competing_hold_and_releases_on_failure() {
    let authored = metadata_catalog();
    let (fixture, key, root, _directory, library, catalog, scope) =
        managed_fixture_for_policy(authored.clone(), true).await;
    let empty = assessment_document(&scope.policy_sha256, 1, vec![]);
    let accepted = publish_assessment(&fixture, &key, &root, &authored, 2, &empty)
        .await
        .unwrap();
    library
        .apply_definition_launch_assessment(&accepted)
        .unwrap();
    let held = assessment_document(
        &scope.policy_sha256,
        2,
        vec![held(&record(), "launch-integrity", 2)],
    );
    let accepted = publish_assessment(&fixture, &key, &root, &authored, 3, &held)
        .await
        .unwrap();
    let identity = catalog.definition_selection(ID).unwrap();
    let context = launch_context(&record(), crate::Platform::current().unwrap());
    let competing_library = library.clone();
    let (ready_sender, ready_receiver) = std::sync::mpsc::channel();
    let (done_sender, done_receiver) = std::sync::mpsc::channel();
    let mut worker = None;
    launch::with_launch_admission(&library, || {
        // A separate connection proves exclusion at the actual SQLite boundary,
        // without treating absence of a scheduled thread result as lock proof.
        let mut competing = library.connection()?;
        competing.busy_timeout(std::time::Duration::ZERO)?;
        let error = competing
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .err()
            .expect("competing admission must not obtain a writer");
        assert!(matches!(error, rusqlite::Error::SqliteFailure(code, _)
            if code.code == rusqlite::ErrorCode::DatabaseBusy));
        worker = Some(std::thread::spawn(move || {
            ready_sender.send(()).unwrap();
            done_sender
                .send(competing_library.apply_definition_launch_assessment(&accepted))
                .unwrap();
        }));
        ready_receiver
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        assert_eq!(
            library
                .assess_definition_operation(identity, context)?
                .outcome,
            DefinitionEligibilityOutcome::Eligible
        );
        assert!(matches!(
            done_receiver.try_recv(),
            Err(std::sync::mpsc::TryRecvError::Empty)
        ));
        // Production creates the child in this same protected interval and then
        // releases it before session writes or waiting on the child.
        Ok(())
    })
    .unwrap();
    assert!(
        done_receiver
            .recv_timeout(std::time::Duration::from_secs(10))
            .unwrap()
            .unwrap()
    );
    worker.take().unwrap().join().unwrap();
    assert_eq!(
        library
            .assess_definition_operation(identity, context)
            .unwrap()
            .reason,
        DefinitionEligibilityReason::MandatoryCheckFailed
    );
    let refused: crate::Result<()> = launch::with_launch_admission(&library, || {
        Err(PortcoveError::state("controlled pre-spawn refusal"))
    });
    assert!(refused.is_err());
    let mut connection = library.connection().unwrap();
    connection.busy_timeout(std::time::Duration::ZERO).unwrap();
    let guard = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .unwrap();
    drop(guard);
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
