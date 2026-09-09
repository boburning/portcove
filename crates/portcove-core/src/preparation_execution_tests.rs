use super::*;
use crate::operation::{
    LifecycleFaultInjector, LifecycleFaultPoint, LifecyclePhase, NoLifecycleFaults, OperationStore,
};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

const CHILD: &str = "preparation::tests::execution_tests::native_setup_fixture_child";

impl Fixture {
    fn native(mode: &str) -> Self {
        let mut fixture = Self::new();
        fs::copy(std::env::current_exe().unwrap(), &fixture.setup).unwrap();
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
        port.setup_arguments = vec!["--exact".into(), CHILD.into(), "--nocapture".into()];
        let qualification =
            InstallQualification::from_port(port, Platform::current().unwrap()).unwrap();
        let (manifest, selected, runtime) = Installer::new(fixture.service.library().clone())
            .unwrap()
            .create_manifest(
                &fixture.install.id,
                PORT,
                &fixture.install.version,
                &fixture.install.artifact,
                &qualification,
                &fixture.install.path,
            )
            .unwrap();
        fixture.install.manifest_sha256 = manifest;
        fixture.install.selected_executable = selected;
        fixture.install.runtime = runtime;
        fixture
            .service
            .library()
            .update_install_manifest(&fixture.install)
            .unwrap();
        fixture.service.replace_catalog_for_test(
            Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap(),
        );
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
fn native_setup_fixture_child() {
    let Ok(mode) = fs::read_to_string("owned-setup-mode") else {
        return;
    };
    fs::create_dir_all("data/out/jak1/iso").unwrap();
    if mode == "missing-marker" {
        return;
    }
    fs::write("data/out/jak1/iso/0COMMON.TXT", b"owned validated output").unwrap();
    fs::create_dir_all("data/log").unwrap();
    fs::write("data/log/setup.log", b"disposable diagnostic").unwrap();
    match mode.as_str() {
        "success" => {}
        "unowned-output" => fs::write("unexpected-output", b"outside contract").unwrap(),
        "save-change" => fs::write("OpenGOAL/jak1/save.bin", b"bad save change").unwrap(),
        "executable-change" => fs::write(
            if cfg!(windows) { "gk.exe" } else { "gk" },
            b"bad executable change",
        )
        .unwrap(),
        "failure" => std::process::exit(23),
        "wait" => {
            fs::write("data/out/setup-ready", b"ready").unwrap();
            std::thread::sleep(Duration::from_secs(8));
        }
        _ => panic!("unknown owned fixture mode"),
    }
}

#[test]
fn preparation_publishes_a_verified_derivative_and_preserves_the_staged_update() {
    let fixture = Fixture::native("success");
    let library = fixture.service.library();
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
    let qualification = InstallQualification::from_port(
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
    assert!(fixture.run(|_| {}).is_err());
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

fn assert_recovery(point: LifecycleFaultPoint, publishable: bool) {
    let mut fixture = Fixture::native("success");
    let original = crate::library_transfer::reviewed_tree(&fixture.install.path).unwrap();
    fixture.set_faults(Arc::new(Fault(point)));
    assert!(fixture.run(|_| {}).is_err());
    fixture.set_faults(Arc::new(NoLifecycleFaults));
    let store = OperationStore::new(fixture.service.library().clone());
    let mut journal = store.all().unwrap().remove(0);
    let private = journal.paths.staging.clone().unwrap();
    let recovered = {
        let _guard = fixture
            .service
            .library()
            .try_lock_port(PORT, "owned recovery fixture")
            .unwrap();
        super::super::recover(&fixture.service, &store, &mut journal)
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
        let retried = fixture.run(|_| {}).unwrap();
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
    assert!(fixture.run(|_| {}).is_err());
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
                        if ready.is_file() {
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
