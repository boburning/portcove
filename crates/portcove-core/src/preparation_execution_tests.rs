use super::*;
use crate::RepairItemKind;
use crate::operation::{
    LifecycleFaultInjector, LifecycleFaultPoint, LifecycleOperation, LifecycleOperationKind,
    LifecyclePhase, NoLifecycleFaults, OperationStore,
};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

impl Fixture {
    fn native(mode: &str) -> Self {
        let mut fixture = Self::new();
        let native = tempfile::tempdir().unwrap();
        test_phase("preparation fixture: native probe and copy", || {
            fs::copy(
                crate::test_fixture::build_probe(native.path()),
                &fixture.setup,
            )
        })
        .unwrap();
        crate::permissions::normalize_archive_entry(&fixture.setup, false, true).unwrap();
        fs::write(fixture.install.path.join("owned-setup-mode"), mode).unwrap();
        let save = fixture.install.path.join("OpenGOAL/jak1/save.bin");
        fs::create_dir_all(save.parent().unwrap()).unwrap();
        fs::write(save, b"preserved player save").unwrap();
        let mut document = fixture.service.catalog().document().clone();
        let port = document
            .ports
            .iter_mut()
            .find(|port| port.id == PORT)
            .unwrap();
        port.setup_arguments = vec!["--owned-preparation".into()];
        let qualification = test_phase("preparation fixture: native qualification", || {
            crate::test_fixture::retained_qualification(port, Platform::current().unwrap())
        })
        .unwrap();
        let (manifest, selected, runtime) =
            test_phase("preparation fixture: native manifest", || {
                Installer::new(fixture.service.library().clone())
                    .unwrap()
                    .create_manifest(
                        &fixture.install.id,
                        PORT,
                        &fixture.install.version,
                        &fixture.install.artifact,
                        &qualification,
                        &fixture.install.path,
                    )
            })
            .unwrap();
        fixture.install.manifest_sha256 = manifest;
        fixture.install.selected_executable = selected;
        fixture.install.runtime = runtime;
        test_phase("preparation fixture: update manifest", || {
            fixture
                .service
                .library()
                .update_install_manifest(&fixture.install)
        })
        .unwrap();
        test_phase("preparation fixture: replace catalog", || {
            fixture.service.replace_catalog_for_test(
                Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap(),
            )
        });
        fixture
    }

    fn run(&self, emit: impl FnMut(crate::OperationEvent)) -> Result<InstallRecord> {
        let plan = self.service.plan_preparation(PORT, self.options())?;
        let authorization =
            self.service
                .authorize_preparation(PORT, self.options(), &plan.plan_sha256)?;
        self.service
            .prepare(PORT, self.options(), &authorization.token, emit)
    }

    fn set_faults(&mut self, faults: Arc<dyn LifecycleFaultInjector>) {
        let catalog = self.service.catalog().clone();
        let mut service =
            PortcoveService::with_faults(self.service.library().clone(), faults).unwrap();
        service.replace_catalog_for_test(catalog);
        self.service = service;
    }
}

#[test]
fn preparation_publishes_a_verified_derivative_and_preserves_the_staged_update() {
    let fixture = Fixture::native("success");
    let library = fixture.service.library().clone();
    let mut staged = fixture.install.clone();
    staged.id = uuid::Uuid::new_v4().to_string();
    staged.artifact.sha256 = crate::signed_catalog::digest(b"separately staged artifact");
    staged.path = library
        .versions_dir()
        .join(PORT)
        .join(&staged.artifact.sha256);
    staged.version = "next-fixture".into();
    staged.staged = true;
    crate::service::copy_tree(&fixture.install.path, &staged.path).unwrap();
    let qualification = crate::test_fixture::retained_qualification(
        fixture.service.catalog().port(PORT).unwrap(),
        Platform::current().unwrap(),
    )
    .unwrap();
    let installer = Installer::new(library.clone()).unwrap();
    let (manifest, selected, runtime) = installer
        .create_manifest(
            &staged.id,
            PORT,
            &staged.version,
            &staged.artifact,
            &qualification,
            &staged.path,
        )
        .unwrap();
    staged.manifest_sha256 = manifest;
    staged.selected_executable = selected;
    staged.runtime = runtime;
    library.register_install(&staged, false).unwrap();
    let original = crate::library_transfer::reviewed_tree(&fixture.install.path).unwrap();
    let mut events = Vec::new();
    let prepared = fixture.run(|event| events.push(event)).unwrap();
    assert_ne!(prepared.id, fixture.install.id);
    assert_ne!(prepared.path, fixture.install.path);
    assert_eq!(prepared.artifact, fixture.install.artifact);
    assert!(
        installer
            .verify_managed(&prepared, &qualification)
            .unwrap()
            .valid
    );
    let status = fixture.service.status(PORT).unwrap();
    assert_eq!(status.active.unwrap().id, prepared.id);
    assert_eq!(status.previous.unwrap().id, fixture.install.id);
    assert_eq!(status.staged.unwrap().id, staged.id);
    assert!(!status.readiness.unwrap().pending_setup);
    assert_eq!(
        crate::library_transfer::reviewed_tree(&fixture.install.path).unwrap(),
        original
    );
    assert_eq!(
        fs::read(prepared.path.join("OpenGOAL/jak1/save.bin")).unwrap(),
        b"preserved player save"
    );
    assert!(prepared.path.join(RECEIPT_FILE).is_file());
    assert!(
        OperationStore::new(library.clone())
            .all()
            .unwrap()
            .is_empty()
    );
    assert!(matches!(
        events.last().unwrap().event,
        crate::OperationEventKind::Finished {
            result: crate::OperationResult::Succeeded
        }
    ));
    fs::write(prepared.path.join(RECEIPT_FILE), b"tampered receipt").unwrap();
    assert_eq!(
        installer
            .verify_critical(&prepared, &qualification)
            .unwrap_err()
            .code,
        ErrorCode::Verification
    );
}

fn assert_private_failure(mode: &str) {
    let fixture = Fixture::native(mode);
    let before = crate::library_transfer::reviewed_tree(&fixture.install.path).unwrap();
    let error = fixture.run(|_| {}).unwrap_err();
    let expected = match mode {
        "missing-marker" => "setup completed without its declared output marker",
        "failure" => "upstream setup rejected or could not prepare the source (exit 23)",
        _ => {
            "setup changed files outside its declared output ownership; active installation was preserved"
        }
    };
    assert_eq!(error.message, expected);
    let reopened = Library::open(fixture.service.library().root()).unwrap();
    let activity = reopened
        .activities(10)
        .unwrap()
        .into_iter()
        .find(|activity| activity.operation == crate::ActivityOperation::Prepare)
        .unwrap();
    assert_eq!(activity.failure.as_ref().unwrap(), &error.report());
    let captures = reopened.activity_diagnostic(&activity.id).unwrap();
    let capture = captures.last().unwrap();
    assert!(capture.complete);
    assert!(capture.stdout.text.contains("owned setup began"));
    assert!(
        capture
            .stderr
            .text
            .contains("owned setup diagnostic on stderr")
    );
    assert!(!capture.stdout.text.contains("owned-fixture-private-value"));
    assert_eq!(
        error.presentation().mutation_state,
        crate::MutationState::RecoveryRequired
    );
    if mode == "failure" {
        assert_eq!(
            error.presentation().phase.as_deref(),
            Some("preparation.setup")
        );
        assert_eq!(error.details["exit_code"], "23");
    }
    assert_eq!(
        fixture.service.status(PORT).unwrap().active.unwrap().id,
        fixture.install.id
    );
    assert_eq!(
        crate::library_transfer::reviewed_tree(&fixture.install.path).unwrap(),
        before
    );
    let journal = OperationStore::new(fixture.service.library().clone())
        .all()
        .unwrap();
    assert_eq!(journal.len(), 1);
    assert_eq!(journal[0].phase, LifecyclePhase::Preparing);
    assert!(!journal[0].paths.final_path.as_ref().unwrap().exists());
}

macro_rules! failure_cases {
    ($($name:ident: $mode:literal),+ $(,)?) => { $(#[test] fn $name() { assert_private_failure($mode); })+ };
}
failure_cases! {
    absent_marker_never_publishes: "missing-marker",
    undeclared_output_never_publishes: "unowned-output",
    changed_save_never_publishes: "save-change",
    changed_executable_never_publishes: "executable-change",
    unsuccessful_native_setup_never_publishes: "failure",
}

fn retained_cleanup_fixture() -> (Fixture, String, std::path::PathBuf) {
    let fixture = Fixture::new();
    let library = fixture.service.library();
    let plan = fixture
        .service
        .plan_preparation(PORT, fixture.options())
        .unwrap();
    let activity = library
        .begin_activity(
            crate::ActivityOperation::Prepare,
            crate::ActivityTargetKind::Port,
            Some(PORT),
        )
        .unwrap();
    library
        .finish_activity(
            &activity.id,
            crate::ActivityStatus::Failed,
            Some("owned retained preparation fixture"),
        )
        .unwrap();
    let retained = library.staging_dir().join(&activity.id);
    fs::create_dir_all(retained.join("payload/generated")).unwrap();
    fs::write(
        retained.join("payload/generated/private.bin"),
        b"owned retained bytes",
    )
    .unwrap();
    let mut journal = LifecycleOperation::new(&activity.id, LifecycleOperationKind::Prepare, PORT);
    journal.paths.staging = Some(retained.clone());
    journal.paths.final_path = Some(
        crate::output_root::validate_install_path(library, PORT, &fixture.install.path)
            .unwrap()
            .parent()
            .unwrap()
            .join(crate::signed_catalog::digest(
                &serde_json::to_vec(&(
                    "Portcove prepared derivative v1",
                    &plan.plan_sha256,
                    &activity.id,
                ))
                .unwrap(),
            )),
    );
    journal.preparation = Some(plan);
    journal.preparation_process_quiesced = Some(true);
    journal.activate = true;
    journal.last_error = Some("owned retained preparation fixture".into());
    OperationStore::new(library.clone())
        .put(&mut journal)
        .unwrap();
    (fixture, activity.id, retained)
}

#[test]
fn reviewed_preparation_cleanup_is_exact_and_preserves_other_library_state() {
    let (fixture, operation_id, retained) = retained_cleanup_fixture();
    let library = fixture.service.library();
    let user = library.user_dir(PORT).join("save.bin");
    let backup = library.backups_dir().join(PORT).join("backup.bin");
    let log = library.logs_dir().join("retained.log");
    fs::create_dir_all(user.parent().unwrap()).unwrap();
    fs::create_dir_all(backup.parent().unwrap()).unwrap();
    fs::write(&user, b"owned save").unwrap();
    fs::write(&backup, b"owned backup").unwrap();
    fs::write(&log, b"owned log").unwrap();
    let original = crate::library_transfer::reviewed_tree(&fixture.install.path).unwrap();
    let source = fs::read(&fixture.source).unwrap();

    let preview = fixture
        .service
        .preview_preparation_cleanup(&operation_id)
        .unwrap();
    assert_eq!(preview.operation_id, operation_id);
    assert_eq!(preview.port_id, PORT);
    assert_eq!(preview.retained_path, retained);
    assert_eq!(preview.retained.files.len(), 1);
    assert_eq!(preview.retained.total_bytes, 20);
    assert_eq!(preview.original_install_path, fixture.install.path);
    assert_eq!(preview.source_path, fixture.source);
    assert!(preview.cleanup_is_irreversible);
    assert!(preview.interrupted_cleanup_will_retry);

    let authorization = fixture
        .service
        .authorize_preparation_cleanup(&operation_id, &preview.preview_sha256)
        .unwrap();
    fs::write(retained.join("changed-after-review.bin"), b"changed").unwrap();
    let stale = fixture
        .service
        .cleanup_preparation(&operation_id, &authorization.token)
        .unwrap_err();
    assert_eq!(stale.code, ErrorCode::Conflict);
    assert!(retained.exists());

    let current = fixture
        .service
        .preview_preparation_cleanup(&operation_id)
        .unwrap();
    let authorization = fixture
        .service
        .authorize_preparation_cleanup(&operation_id, &current.preview_sha256)
        .unwrap();
    let removed = fixture
        .service
        .cleanup_preparation(&operation_id, &authorization.token)
        .unwrap();
    assert_eq!(removed.preview_sha256, current.preview_sha256);
    assert!(!retained.exists());
    assert!(
        OperationStore::new(library.clone())
            .all()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        crate::library_transfer::reviewed_tree(&fixture.install.path).unwrap(),
        original
    );
    assert_eq!(fs::read(&fixture.source).unwrap(), source);
    assert_eq!(fs::read(user).unwrap(), b"owned save");
    assert_eq!(fs::read(backup).unwrap(), b"owned backup");
    assert_eq!(fs::read(log).unwrap(), b"owned log");
    assert_eq!(
        library.activities(1).unwrap()[0].status,
        crate::ActivityStatus::Failed
    );
}

#[test]
fn reviewed_cleanup_pending_resumes_without_turning_failed_preparation_into_success() {
    let (fixture, operation_id, retained) = retained_cleanup_fixture();
    let library = fixture.service.library();
    let store = OperationStore::new(library.clone());
    let preview = fixture
        .service
        .preview_preparation_cleanup(&operation_id)
        .unwrap();
    let mut journal = store.all().unwrap().remove(0);
    journal.phase = LifecyclePhase::CleanupPending;
    let quarantine = super::super::execution::cleanup_quarantine_path(
        &retained,
        &operation_id,
        &preview.preview_sha256,
    )
    .unwrap();
    journal.paths.quarantine = Some(quarantine.clone());
    journal.last_error = None;
    store.put(&mut journal).unwrap();
    fs::rename(&retained, &quarantine).unwrap();

    let reopened = PortcoveService::new(Library::open(library.root()).unwrap()).unwrap();
    assert!(!retained.exists());
    assert!(!quarantine.exists());
    assert!(
        OperationStore::new(library.clone())
            .all()
            .unwrap()
            .is_empty()
    );
    let activity = reopened
        .library()
        .activities(10)
        .unwrap()
        .into_iter()
        .find(|activity| activity.id == operation_id)
        .unwrap();
    assert_eq!(activity.status, crate::ActivityStatus::Failed);
    assert_eq!(
        reopened.status(PORT).unwrap().active.unwrap().id,
        fixture.install.id
    );
}

#[test]
fn cleanup_retry_preserves_private_files_created_after_the_reviewed_tree_was_quarantined() {
    let (fixture, operation_id, retained) = retained_cleanup_fixture();
    let library = fixture.service.library();
    let store = OperationStore::new(library.clone());
    let preview = fixture
        .service
        .preview_preparation_cleanup(&operation_id)
        .unwrap();
    let mut journal = store.all().unwrap().remove(0);
    let quarantine = super::super::execution::cleanup_quarantine_path(
        &retained,
        &operation_id,
        &preview.preview_sha256,
    )
    .unwrap();
    journal.phase = LifecyclePhase::CleanupPending;
    journal.paths.quarantine = Some(quarantine.clone());
    journal.last_error = None;
    store.put(&mut journal).unwrap();
    fs::rename(&retained, &quarantine).unwrap();
    fs::create_dir_all(&retained).unwrap();
    fs::write(retained.join("created-after-consent.bin"), b"unreviewed").unwrap();

    let reopened = PortcoveService::new(Library::open(library.root()).unwrap()).unwrap();
    assert!(!quarantine.exists());
    assert_eq!(
        fs::read(retained.join("created-after-consent.bin")).unwrap(),
        b"unreviewed"
    );
    let pending = OperationStore::new(library.clone())
        .all()
        .unwrap()
        .remove(0);
    assert_eq!(pending.phase, LifecyclePhase::Preparing);
    assert!(pending.paths.quarantine.is_none());
    let current = reopened.preview_preparation_cleanup(&operation_id).unwrap();
    assert_eq!(current.retained.files.len(), 1);
    assert_eq!(
        reopened.library().activities(1).unwrap()[0].status,
        crate::ActivityStatus::Failed
    );
}

#[test]
fn preparation_cleanup_rejects_busy_wrong_kind_and_out_of_root_work() {
    let (fixture, operation_id, retained) = retained_cleanup_fixture();
    let library = fixture.service.library();
    let store = OperationStore::new(library.clone());
    let activity_guard = library.try_lock_activity(&operation_id).unwrap();
    assert_eq!(
        fixture
            .service
            .preview_preparation_cleanup(&operation_id)
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    drop(activity_guard);

    let mut journal = store.all().unwrap().remove(0);
    journal.kind = LifecycleOperationKind::Install;
    store.put(&mut journal).unwrap();
    assert_eq!(
        fixture
            .service
            .preview_preparation_cleanup(&operation_id)
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    assert!(retained.exists());

    journal.kind = LifecycleOperationKind::Prepare;
    journal.paths.staging = Some(fixture.source.clone());
    store.put(&mut journal).unwrap();
    assert_eq!(
        fixture
            .service
            .preview_preparation_cleanup(&operation_id)
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    assert!(fixture.source.is_file());
    assert!(retained.exists());
}

#[test]
fn preparation_cleanup_refuses_unknown_process_quiescence() {
    let (fixture, operation_id, retained) = retained_cleanup_fixture();
    let store = OperationStore::new(fixture.service.library().clone());
    let mut journal = store.all().unwrap().remove(0);
    journal.preparation_process_quiesced = None;
    store.put(&mut journal).unwrap();

    let error = fixture
        .service
        .preview_preparation_cleanup(&operation_id)
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Conflict);
    assert!(error.message.contains("quiescence is not proven"));
    assert!(retained.exists());
}

#[test]
fn activity_retention_preserves_rows_owned_by_lifecycle_journals() {
    let (fixture, operation_id, retained) = retained_cleanup_fixture();
    let connection = fixture.service.library().connection().unwrap();
    connection
        .execute_batch(
            "WITH RECURSIVE sequence(value) AS (
               SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value <= 1001
             )
             INSERT INTO activity_history(
               id, operation, target_kind, target_id, status, started_at, finished_at
             )
             SELECT printf('retention-%04d', value), 'verify_source', 'library', NULL,
                    'succeeded', 1000 + value, 1000 + value
             FROM sequence;",
        )
        .unwrap();
    let trigger = fixture
        .service
        .library()
        .begin_activity(
            crate::ActivityOperation::VerifySource,
            crate::ActivityTargetKind::Library,
            None,
        )
        .unwrap();
    fixture
        .service
        .library()
        .finish_activity(&trigger.id, crate::ActivityStatus::Succeeded, None)
        .unwrap();

    assert!(
        fixture
            .service
            .library()
            .activities(2000)
            .unwrap()
            .iter()
            .any(|activity| activity.id == operation_id)
    );
    assert!(
        fixture
            .service
            .preview_preparation_cleanup(&operation_id)
            .is_ok()
    );
    assert!(retained.exists());
}

struct Fault(LifecycleFaultPoint);
impl LifecycleFaultInjector for Fault {
    fn check(&self, point: LifecycleFaultPoint) -> Result<()> {
        if point == self.0 {
            Err(PortcoveError::state("owned preparation interruption"))
        } else {
            Ok(())
        }
    }
}

#[test]
fn journal_only_preparation_cleanup_removes_only_the_stale_journal() {
    let mut fixture = Fixture::native("success");
    let library = fixture.service.library().clone();
    let active = fixture.service.status(PORT).unwrap().active.unwrap();
    let original = crate::library_transfer::reviewed_tree(&active.path).unwrap();
    let source = fs::read(&fixture.source).unwrap();
    let user = library.user_dir(PORT).join("journal-only-save.bin");
    let backup = library
        .backups_dir()
        .join(PORT)
        .join("journal-only-backup.bin");
    let log = library.logs_dir().join("journal-only-cleanup.log");
    fs::create_dir_all(user.parent().unwrap()).unwrap();
    fs::create_dir_all(backup.parent().unwrap()).unwrap();
    fs::write(&user, b"owned save").unwrap();
    fs::write(&backup, b"owned backup").unwrap();
    fs::write(&log, b"owned log").unwrap();

    fixture.set_faults(Arc::new(Fault(LifecycleFaultPoint::PreparationJournaled)));
    assert_eq!(
        fixture.run(|_| {}).unwrap_err().message,
        "owned preparation interruption"
    );
    fixture.set_faults(Arc::new(NoLifecycleFaults));

    let store = OperationStore::new(library.clone());
    let journal = store.all().unwrap().remove(0);
    let retained = journal.paths.staging.unwrap();
    assert!(!retained.exists());
    let plan = journal.preparation.as_ref().unwrap();
    let original_install = crate::output_root::validate_install_path(
        &library,
        &journal.port_id,
        &plan.inputs.install.path,
    )
    .unwrap();
    let expected_final = original_install
        .parent()
        .unwrap()
        .join(crate::signed_catalog::digest(
            &serde_json::to_vec(&(
                "Portcove prepared derivative v1",
                &plan.plan_sha256,
                &journal.id,
            ))
            .unwrap(),
        ));
    assert_eq!(journal.paths.final_path.as_ref(), Some(&expected_final));
    assert!(!expected_final.exists(), "{expected_final:?}");
    let activity = library
        .activities(10)
        .unwrap()
        .into_iter()
        .find(|activity| activity.id == journal.id)
        .unwrap();
    assert_eq!(activity.status, crate::ActivityStatus::Failed);

    let reopened = PortcoveService::new(Library::open(library.root()).unwrap()).unwrap();
    let retained_after_reopen = store.all().unwrap().remove(0);
    assert_eq!(
        retained_after_reopen.last_error.as_deref(),
        Some("owned preparation interruption")
    );
    assert_eq!(
        library
            .activities(10)
            .unwrap()
            .into_iter()
            .find(|current| current.id == activity.id)
            .unwrap(),
        activity
    );

    let preview = reopened.preview_preparation_cleanup(&journal.id).unwrap();
    assert_eq!(preview.retained_path, retained);
    assert!(preview.retained.directories.is_empty());
    assert!(preview.retained.files.is_empty());
    assert!(preview.retained.skipped_entries.is_empty());
    assert_eq!(preview.retained.total_bytes, 0);
    let authorization = reopened
        .authorize_preparation_cleanup(&journal.id, &preview.preview_sha256)
        .unwrap();
    let removed = reopened
        .cleanup_preparation(&journal.id, &authorization.token)
        .unwrap();
    assert_eq!(removed.preview_sha256, preview.preview_sha256);
    assert!(!retained.exists());
    assert!(store.all().unwrap().is_empty());
    assert_eq!(
        serde_json::to_value(reopened.status(PORT).unwrap().active.unwrap()).unwrap(),
        serde_json::to_value(&active).unwrap()
    );
    assert_eq!(
        crate::library_transfer::reviewed_tree(&active.path).unwrap(),
        original
    );
    assert_eq!(fs::read(&fixture.source).unwrap(), source);
    assert_eq!(fs::read(user).unwrap(), b"owned save");
    assert_eq!(fs::read(backup).unwrap(), b"owned backup");
    assert_eq!(fs::read(log).unwrap(), b"owned log");
    assert_eq!(
        library
            .activities(10)
            .unwrap()
            .into_iter()
            .find(|current| current.id == activity.id)
            .unwrap(),
        activity
    );
}

fn assert_recovery(point: LifecycleFaultPoint, publishable: bool) {
    use crate::test_fixture::phase;
    let mut fixture = phase("preparation recovery: native fixture", || {
        Fixture::native("success")
    });
    let original = crate::library_transfer::reviewed_tree(&fixture.install.path).unwrap();
    phase("preparation recovery: open fault-injected service", || {
        fixture.set_faults(Arc::new(Fault(point)))
    });
    assert_eq!(
        phase("preparation recovery: interrupt", || fixture.run(|_| {}))
            .unwrap_err()
            .message,
        "owned preparation interruption"
    );
    phase("preparation recovery: reopen and recover", || {
        fixture.set_faults(Arc::new(NoLifecycleFaults))
    });
    let store = OperationStore::new(fixture.service.library().clone());
    let mut journal = store.all().unwrap().remove(0);
    let private = journal.paths.staging.clone().unwrap();
    let recovered = {
        let _guard = fixture
            .service
            .library()
            .try_lock_port(PORT, "owned recovery fixture")
            .unwrap();
        phase("preparation recovery: recover journal", || {
            super::super::recover(&fixture.service, &store, &mut journal)
        })
    };
    if publishable {
        recovered.unwrap();
        assert_eq!(
            fixture.service.status(PORT).unwrap().active.unwrap().id,
            journal.id
        );
        assert!(store.all().unwrap().is_empty());
    } else {
        assert!(recovered.is_err());
        assert_eq!(
            fixture.service.status(PORT).unwrap().active.unwrap().id,
            fixture.install.id
        );
        let retried = phase("preparation recovery: retry privately", || {
            fixture.run(|_| {})
        })
        .unwrap();
        assert_ne!(retried.id, journal.id);
        assert!(private.exists() || point == LifecycleFaultPoint::PreparationJournaled);
        assert_eq!(store.all().unwrap().len(), 1);
    }
    assert_eq!(
        crate::library_transfer::reviewed_tree(&fixture.install.path).unwrap(),
        original
    );
}

macro_rules! recovery_cases {
    ($($name:ident: $point:ident, $publishable:literal),+ $(,)?) => { $(#[test] fn $name() { assert_recovery(LifecycleFaultPoint::$point, $publishable); })+ };
}
recovery_cases! {
    journal_interruption_retries_privately: PreparationJournaled, false,
    copy_interruption_retries_privately: PreparationCopied, false,
    tool_interruption_retries_privately: PreparationToolCompleted, false,
    validation_interruption_retries_privately: PreparationOutputsValidated, false,
    prepared_interruption_finishes_verified_publication: PreparationPrepared, true,
    published_interruption_finishes_registration: PreparationPublished, true,
    registered_interruption_finishes_cleanup: PreparationRegistered, true,
}

#[test]
fn source_change_blocks_prepared_recovery_without_switching_versions() {
    let mut fixture = Fixture::native("success");
    fixture.set_faults(Arc::new(Fault(LifecycleFaultPoint::PreparationPrepared)));
    assert_eq!(
        fixture.run(|_| {}).unwrap_err().message,
        "owned preparation interruption"
    );
    fixture.set_faults(Arc::new(NoLifecycleFaults));
    fs::write(&fixture.source, b"changed original source").unwrap();
    let store = OperationStore::new(fixture.service.library().clone());
    let mut journal = store.all().unwrap().remove(0);
    let _guard = fixture
        .service
        .library()
        .try_lock_port(PORT, "owned recovery fixture")
        .unwrap();
    assert!(super::super::recover(&fixture.service, &store, &mut journal).is_err());
    assert_eq!(
        fixture.service.status(PORT).unwrap().active.unwrap().id,
        fixture.install.id
    );
}

#[test]
fn running_setup_cancellation_preserves_the_active_tree() {
    let fixture = Fixture::native("wait");
    let original = crate::library_transfer::reviewed_tree(&fixture.install.path).unwrap();
    let cancellation = PortcoveService::new(fixture.service.library().clone()).unwrap();
    let mut cancellation = Some(cancellation);
    let mut worker = None;
    let started = Instant::now();
    let error = fixture
        .run(|event| {
            if matches!(event.event, crate::OperationEventKind::Started) {
                let service = cancellation.take().unwrap();
                let id = event.operation_id.clone();
                worker = Some(std::thread::spawn(move || {
                    let ready = service
                        .library()
                        .staging_dir()
                        .join(&id)
                        .join("payload/data/out/setup-ready");
                    let deadline = Instant::now() + Duration::from_secs(5);
                    while Instant::now() < deadline {
                        if ready.is_file()
                            && let Some(capture) =
                                service.library().activity_diagnostic(&id).unwrap().last()
                            && capture.stdout.text.contains("owned setup began")
                        {
                            assert!(!capture.complete);
                            assert!(!capture.stdout.text.contains("owned-fixture-private-value"));
                            return service.request_cancellation(&id).is_ok();
                        }
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    false
                }));
            }
        })
        .unwrap_err();
    assert!(worker.unwrap().join().unwrap());
    assert_eq!(error.code, ErrorCode::Cancelled);
    assert!(started.elapsed() < Duration::from_secs(7));
    assert_eq!(
        fixture.service.status(PORT).unwrap().active.unwrap().id,
        fixture.install.id
    );
    assert_eq!(
        crate::library_transfer::reviewed_tree(&fixture.install.path).unwrap(),
        original
    );
}

#[test]
fn private_preparation_review_does_not_substitute_a_planned_destination() {
    let fixture = Fixture::new();
    let library = fixture.service.library();
    let store = OperationStore::new(library.clone());
    let id = uuid::Uuid::new_v4().to_string();
    let private = library.staging_dir().join(&id);
    let planned = fixture
        .install
        .path
        .parent()
        .unwrap()
        .join("planned-output");
    let mut journal = LifecycleOperation::new(&id, LifecycleOperationKind::Prepare, PORT);
    journal.paths.final_path = Some(planned.clone());
    for (phase, staging, expected, expected_kind) in [
        (
            LifecyclePhase::Preparing,
            Some(private.clone()),
            Some(private.clone()),
            RepairItemKind::RetainedPreparation,
        ),
        (
            LifecyclePhase::Preparing,
            None,
            None,
            RepairItemKind::RetainedPreparation,
        ),
        (
            LifecyclePhase::Prepared,
            Some(private),
            Some(planned.clone()),
            RepairItemKind::PartialOperation,
        ),
    ] {
        journal.phase = phase;
        journal.paths.staging = staging;
        store.put(&mut journal).unwrap();
        let report = fixture.service.repair_plan().unwrap();
        let item = report
            .items
            .iter()
            .find(|item| item.operation_id.as_deref() == Some(&id))
            .unwrap();
        assert_eq!(item.kind, expected_kind);
        assert_eq!(item.path, expected);
        assert!(!planned.exists());
        assert_eq!(store.all().unwrap().remove(0).phase, phase);
    }
}

#[test]
fn interrupted_private_preparation_gets_a_truthful_terminal_report_after_reconnect() {
    for requested in [false, true] {
        let fixture = Fixture::native("failure");
        fixture.run(|_| {}).unwrap_err();
        let library = fixture.service.library();
        let journal = OperationStore::new(library.clone())
            .all()
            .unwrap()
            .remove(0);
        let private = journal.paths.staging.as_ref().unwrap();
        let before = crate::library_transfer::reviewed_tree(private).unwrap();
        let original = crate::library_transfer::reviewed_tree(&fixture.install.path).unwrap();
        // Recreate the durable state left by a worker exiting before its final
        // activity update. This is an isolated interruption fixture, not a claim
        // about how a physical host terminates an upstream process tree.
        library.connection().unwrap().execute(
            "UPDATE activity_history SET status='running',finished_at=NULL,message=NULL,failure_json=NULL,cancellation_phase='preparing',cancel_requested=?2 WHERE id=?1",
            rusqlite::params![journal.id, requested],
        ).unwrap();
        let capture = crate::activity_diagnostics::DiagnosticCapture::default();
        capture
            .record(0, b"last saved output token=owned-interruption-secret")
            .unwrap();
        let partial = capture
            .snapshot(&journal.id, "preparation.setup", false)
            .unwrap();
        library.record_activity_diagnostic(&partial).unwrap();
        let reopened = PortcoveService::new(Library::open(library.root()).unwrap()).unwrap();
        let activity = reopened.library().activities(1).unwrap().remove(0);
        assert_eq!(activity.id, journal.id);
        assert_eq!(activity.status, crate::ActivityStatus::Failed);
        let failure = activity.failure.as_ref().unwrap();
        assert_eq!(failure.code, ErrorCode::State);
        assert_eq!(
            failure.presentation.presentation_key,
            "preparation_interrupted"
        );
        assert_eq!(failure.presentation.tone, crate::FailureTone::Error);
        assert_eq!(
            failure.presentation.mutation_state,
            crate::MutationState::RecoveryRequired
        );
        assert!(
            failure
                .presentation
                .recovery_actions
                .contains(&crate::RecoveryAction::ReviewPreparation)
        );
        assert_eq!(failure.details["cancel_requested"], requested.to_string());
        assert!(!failure.presentation.summary.contains("cancelled"));
        assert_eq!(
            reopened.library().activity_diagnostic(&journal.id).unwrap(),
            vec![partial]
        );
        assert_eq!(
            crate::library_transfer::reviewed_tree(private).unwrap(),
            before
        );
        assert_eq!(
            crate::library_transfer::reviewed_tree(&fixture.install.path).unwrap(),
            original
        );
        assert_eq!(
            reopened.status(PORT).unwrap().active.unwrap().id,
            fixture.install.id
        );
        let repair = reopened.repair_plan().unwrap();
        let item = repair
            .items
            .iter()
            .find(|item| item.operation_id.as_deref() == Some(journal.id.as_str()))
            .unwrap();
        assert!(item.proposed_action.contains("cannot be resumed"));
        assert!(!item.proposed_action.contains("idempotent"));
        assert_eq!(item.path.as_ref(), Some(private));
        assert_ne!(item.path, journal.paths.final_path);
        let again = PortcoveService::new(Library::open(library.root()).unwrap()).unwrap();
        assert_eq!(again.library().activities(1).unwrap()[0], activity);
    }
}

#[test]
fn preparation_recovery_preserves_existing_outcomes_and_rejects_an_owned_activity_lock() {
    let fixture = Fixture::native("failure");
    let failure = fixture.run(|_| {}).unwrap_err();
    let library = fixture.service.library();
    let store = OperationStore::new(library.clone());
    let mut journal = store.all().unwrap().remove(0);
    let reopened = PortcoveService::new(Library::open(library.root()).unwrap()).unwrap();
    assert_eq!(
        reopened.library().activities(1).unwrap()[0].failure,
        Some(failure.report())
    );
    library.connection().unwrap().execute("UPDATE activity_history SET status='running',cancellation_phase='preparing',failure_json=NULL WHERE id=?1", [&journal.id]).unwrap();
    let _port_guard = library
        .try_lock_port(PORT, "owned recovery fixture")
        .unwrap();
    let guard = library.try_lock_activity(&journal.id).unwrap();
    journal.last_error = None;
    store.put(&mut journal).unwrap();
    let review = fixture.service.repair_plan().unwrap();
    let item = review
        .items
        .iter()
        .find(|item| item.operation_id.as_deref() == Some(journal.id.as_str()))
        .unwrap();
    assert!(!item.message.contains("paused"));
    assert_eq!(item.path, journal.paths.staging);
    assert!(
        item.proposed_action
            .starts_with("review the current activity")
    );
    let error = super::super::recover(&fixture.service, &store, &mut journal).unwrap_err();
    assert_eq!(error.code, ErrorCode::Conflict);
    assert_eq!(
        library.activities(1).unwrap()[0].status,
        crate::ActivityStatus::Running
    );
    drop(guard);
    library
        .connection()
        .unwrap()
        .execute(
            "UPDATE activity_history SET target_id='different-port' WHERE id=?1",
            [&journal.id],
        )
        .unwrap();
    let error = super::super::recover(&fixture.service, &store, &mut journal).unwrap_err();
    assert_eq!(error.code, ErrorCode::Verification);
    assert_eq!(
        library.activities(1).unwrap()[0].status,
        crate::ActivityStatus::Running
    );
}

#[test]
fn preparation_is_explicit_and_play_never_runs_setup_or_recreates_inputs() {
    let fixture = Fixture::native("success");
    let original = crate::library_transfer::reviewed_tree(&fixture.install.path).unwrap();
    assert!(fixture.service.launch_spec(PORT, None).is_err());
    assert_eq!(
        crate::library_transfer::reviewed_tree(&fixture.install.path).unwrap(),
        original
    );
    assert!(
        fixture
            .service
            .status(PORT)
            .unwrap()
            .readiness
            .unwrap()
            .blockers
            .contains(&crate::LaunchBlocker::PreparationRequired)
    );
    let prepared = fixture.run(|_| {}).unwrap();
    let log = prepared.path.join("data/log/setup.log");
    fs::write(&log, b"setup must not run during Play").unwrap();
    fixture.service.launch_spec(PORT, None).unwrap();
    assert_eq!(fs::read(&log).unwrap(), b"setup must not run during Play");
    let port = fixture.service.catalog().port(PORT).unwrap();
    let materialized = prepared
        .path
        .join(port.runtime_source_filename.as_ref().unwrap());
    fs::remove_file(&materialized).unwrap();
    assert!(fixture.service.launch_spec(PORT, None).is_err());
    assert!(!materialized.exists());
}

#[test]
fn retained_definition_survives_catalog_changes_but_missing_receipt_blocks_play() {
    let mut fixture = Fixture::native("success");
    let prepared = fixture.run(|_| {}).unwrap();
    assert!(
        fixture
            .service
            .status(PORT)
            .unwrap()
            .readiness
            .unwrap()
            .launchable
    );
    let original_catalog = fixture.service.catalog().clone();
    let mut document = original_catalog.authoritative_document();
    let profile_id = fixture
        .service
        .catalog()
        .port(PORT)
        .unwrap()
        .source_profile
        .as_ref()
        .unwrap();
    document
        .source_catalog
        .as_mut()
        .unwrap()
        .identities
        .iter_mut()
        .find(|profile| &profile.id == profile_id)
        .unwrap()
        .label = "Changed after preparation".into();
    let port = document
        .ports
        .iter_mut()
        .find(|port| port.id == PORT)
        .unwrap();
    port.presentation.as_mut().unwrap().source_requirements[0].label =
        "Changed after preparation".into();
    port.setup_arguments.push("--changed-option".into());
    fixture.service.replace_catalog_for_test(
        Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap(),
    );
    assert!(
        fixture
            .service
            .status(PORT)
            .unwrap()
            .readiness
            .unwrap()
            .launchable
    );
    assert!(fixture.service.launch_spec(PORT, None).is_ok());
    fixture.service.replace_catalog_for_test(original_catalog);
    fs::remove_file(prepared.path.join(RECEIPT_FILE)).unwrap();
    assert!(
        !fixture
            .service
            .status(PORT)
            .unwrap()
            .readiness
            .unwrap()
            .launchable
    );
    assert!(fixture.service.launch_spec(PORT, None).is_err());
}

#[test]
fn completed_legacy_setup_keeps_working_without_repeating_setup() {
    assert_legacy_setup(false);
}

#[test]
fn completed_nested_legacy_setup_keeps_its_working_directory() {
    assert_legacy_setup(true);
}

fn assert_legacy_setup(nested: bool) {
    let fixture = Fixture::native("success");
    let mut prepared = fixture.run(|_| {}).unwrap();
    fs::remove_file(prepared.path.join(RECEIPT_FILE)).unwrap();
    let working = if nested {
        let entries = fs::read_dir(&prepared.path)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect::<Vec<_>>();
        let working = prepared.path.join("existing-game");
        fs::create_dir(&working).unwrap();
        for path in entries {
            if path.file_name().unwrap() != ".portcove-manifest.json" {
                fs::rename(&path, working.join(path.file_name().unwrap())).unwrap();
            }
        }
        working
    } else {
        prepared.path.clone()
    };

    let port = fixture.service.catalog().port(PORT).unwrap();
    let qualification =
        crate::test_fixture::retained_qualification(port, Platform::current().unwrap()).unwrap();
    let installer = Installer::new(fixture.service.library().clone()).unwrap();
    let (hash, selected, runtime) = installer
        .create_manifest(
            &prepared.id,
            PORT,
            &prepared.version,
            &prepared.artifact,
            &qualification,
            &prepared.path,
        )
        .unwrap();
    prepared.manifest_sha256 = hash;
    prepared.selected_executable = selected;
    prepared.runtime = runtime;
    fixture
        .service
        .library()
        .update_install_manifest(&prepared)
        .unwrap();
    crate::adapter::bind_upstream_setup_manifest(&working, &prepared.manifest_sha256).unwrap();
    fs::write(working.join("data/log/setup.log"), b"legacy sentinel").unwrap();
    assert!(
        fixture
            .service
            .status(PORT)
            .unwrap()
            .readiness
            .unwrap()
            .launchable
    );
    fixture.service.launch_spec(PORT, None).unwrap();
    assert_eq!(
        fs::read(working.join("data/log/setup.log")).unwrap(),
        b"legacy sentinel"
    );
}

#[cfg(unix)]
#[test]
fn readiness_rejects_a_symlink_redirect_even_when_marker_bytes_match() {
    let fixture = Fixture::native("success");
    let prepared = fixture.run(|_| {}).unwrap();
    let marker_root = prepared.path.join("data/out/jak1/iso");
    let redirected = fixture._temporary.path().join("redirected-marker");
    fs::rename(&marker_root, &redirected).unwrap();
    std::os::unix::fs::symlink(&redirected, &marker_root).unwrap();
    let readiness = fixture.service.status(PORT).unwrap().readiness.unwrap();
    assert!(readiness.pending_setup);
    assert!(!readiness.launchable);
}
