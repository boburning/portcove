use super::*;
use crate::{ErrorCode, OperationEventKind, ReleaseAsset, RuntimeOrigin};
use std::{
    collections::BTreeMap,
    io::{Cursor, Write},
    net::TcpListener,
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::Duration,
};

const PORT: &str = "severed-chains";

struct Archives {
    url: String,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}

impl Archives {
    fn new(files: BTreeMap<String, Vec<u8>>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let worker = thread::spawn(move || {
            while !stopping.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        stream.set_nonblocking(false).unwrap();
                        stream
                            .set_read_timeout(Some(Duration::from_secs(2)))
                            .unwrap();
                        let mut request = [0; 4096];
                        let count = stream.read(&mut request).unwrap();
                        let request = String::from_utf8_lossy(&request[..count]);
                        let path = request.split_whitespace().nth(1).unwrap();
                        let bytes = files.get(path.trim_start_matches('/')).unwrap();
                        let _ = write!(
                            stream,
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            bytes.len()
                        );
                        let _ = stream.write_all(bytes);
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5))
                    }
                    Err(error) => panic!("{error}"),
                }
            }
        });
        Self {
            url,
            stop,
            worker: Some(worker),
        }
    }
}

impl Drop for Archives {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let result = self.worker.take().unwrap().join();
        assert!(
            result.is_ok() || thread::panicking(),
            "archive fixture server panicked"
        );
    }
}

fn archive(files: &[(&str, &[u8])]) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, content) in files {
        zip.start_file(
            *name,
            zip::write::SimpleFileOptions::default().unix_permissions(0o755),
        )
        .unwrap();
        zip.write_all(content).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

fn asset(name: &str, bytes: &[u8]) -> ReleaseAsset {
    ReleaseAsset {
        name: name.into(),
        url: format!("https://example.invalid/{name}"),
        size: bytes.len() as u64,
        sha256: hex::encode(Sha256::digest(bytes)),
    }
}

struct Fixture {
    server: Archives,
    port: PortDefinition,
    release: ResolvedRelease,
}

impl Fixture {
    fn new(runtime_bytes: &[u8], game_extra: bool) -> Self {
        let platform = Platform::current().unwrap();
        let mut port = Catalog::embedded().unwrap().port(PORT).unwrap().clone();
        port.platforms = vec![platform];
        port.bundled_runtime.retain(|key, _| *key == platform);
        let runtime = port.bundled_runtime.get_mut(&platform).unwrap();
        runtime.archive_root = "vendor-root".into();
        let runtime_archive = archive(&[
            (
                &format!("vendor-root/{}", runtime.executable),
                b"synthetic runtime executable",
            ),
            ("vendor-root/lib/modules", runtime_bytes),
        ]);
        runtime.asset = asset("runtime.zip", &runtime_archive);
        let executable = &port.executable_hints[&platform][0];
        let mut members = vec![
            (executable.as_str(), b"synthetic game launcher".as_slice()),
            ("libs/game.jar", b"synthetic game code"),
        ];
        if game_extra {
            members.push(("JDK25/collision", b"unexpected dependency"));
        }
        let game = archive(&members);
        let release = ResolvedRelease {
            version: "same-game-release".into(),
            channel: ReleaseChannel::Rolling,
            published_at: None,
            asset: asset("game.zip", &game),
        };
        let server = Archives::new(BTreeMap::from([
            ("game.zip".into(), game),
            ("runtime.zip".into(), runtime_archive),
        ]));
        Self {
            server,
            port,
            release,
        }
    }

    fn request(&self, activate: bool) -> InstallRequest {
        // Transport is local in this fixture; the catalog admission tests still require HTTPS.
        let mut release = self.release.clone();
        release.asset.url = format!("{}/game.zip", self.server.url);
        InstallRequest {
            port_id: PORT.into(),
            release,
            activate,
            managed: None,
            qualification: InstallQualification::from_port(
                &self.port,
                Platform::current().unwrap(),
            )
            .unwrap()
            .with_test_runtime_url(format!("{}/runtime.zip", self.server.url)),
        }
    }

    async fn install(&self, library: &Library, activate: bool) -> InstallRecord {
        Installer::new(library.clone())
            .unwrap()
            .install(
                self.request(activate),
                &OperationCoordinator::new("install", None),
                |_| {},
            )
            .await
            .unwrap()
    }

    fn service(&self, library: Library) -> PortcoveService {
        let mut service =
            PortcoveService::with_provider(library, Arc::new(FixedRelease(self.release.clone())))
                .unwrap();
        let mut document = service.catalog.document().clone();
        *document
            .ports
            .iter_mut()
            .find(|port| port.id == PORT)
            .unwrap() = self.port.clone();
        service.catalog = Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap();
        service
    }
}

struct FixedRelease(ResolvedRelease);
#[async_trait::async_trait]
impl ReleaseProvider for FixedRelease {
    async fn resolve(
        &self,
        _: &PortDefinition,
        _: ReleaseChannel,
        _: Platform,
    ) -> Result<ResolvedRelease> {
        Ok(self.0.clone())
    }
}

#[tokio::test]
async fn named_saves_survive_backup_restore_version_changes_and_reinstallation() {
    let root = tempfile::tempdir().unwrap();
    let library = Library::open(root.path()).unwrap();
    let patterns = vec![crate::PersistentFilePattern {
        prefix: "profile_".into(),
        suffix: ".sav".into(),
    }];
    let mut first = Fixture::new(b"runtime one", false);
    first.port.persistent_file_patterns = patterns.clone();
    let old = first.install(&library, true).await;
    let mut second = Fixture::new(b"runtime two", false);
    second.port.persistent_file_patterns = patterns;
    let staged = second.install(&library, false).await;
    let service = second.service(library.clone());
    fs::write(old.path.join("profile_bob.sav"), b"older synthetic save").unwrap();
    fs::write(old.path.join(LAUNCH_MARKER), b"1").unwrap();
    let backup = service.create_backup(PORT).unwrap();
    fs::write(staged.path.join("profile_default.sav"), b"upstream default").unwrap();
    service.activate_staged(PORT).unwrap();
    assert!(staged.path.join("profile_default.sav").is_file());
    assert_eq!(
        fs::read(staged.path.join("profile_bob.sav")).unwrap(),
        b"older synthetic save"
    );
    fs::write(staged.path.join("profile_bob.sav"), b"newer fixture").unwrap();
    fs::write(staged.path.join("profile_extra.sav"), b"second slot").unwrap();
    fs::write(staged.path.join(LAUNCH_MARKER), b"1").unwrap();
    service.create_backup(PORT).unwrap();
    service.rollback(PORT).unwrap();
    assert_eq!(
        fs::read(old.path.join("profile_bob.sav")).unwrap(),
        b"newer fixture"
    );
    assert!(old.path.join("profile_extra.sav").is_file());
    fs::remove_file(old.path.join("profile_extra.sav")).unwrap();
    service.rollback(PORT).unwrap();
    assert!(!staged.path.join("profile_extra.sav").exists());
    assert!(!library.user_dir(PORT).join("profile_extra.sav").exists());
    fs::write(staged.path.join("profile_extra.sav"), b"second slot").unwrap();
    service.create_backup(PORT).unwrap();
    let preview = service
        .preview_backup_action(PORT, &backup.id, BackupAction::Restore)
        .unwrap();
    let authorization = service
        .authorize_backup_action(
            PORT,
            &backup.id,
            BackupAction::Restore,
            &preview.preview_sha256,
        )
        .unwrap();
    let restored = service
        .restore_backup(PORT, &backup.id, &authorization.token)
        .unwrap();
    assert_eq!(
        fs::read(
            restored
                .safety_backup
                .unwrap()
                .path
                .join("data/profile_extra.sav")
        )
        .unwrap(),
        b"second slot"
    );
    for install in [&old, &staged] {
        assert_eq!(
            fs::read(install.path.join("profile_bob.sav")).unwrap(),
            b"older synthetic save"
        );
        assert!(!install.path.join("profile_extra.sav").exists());
        let installer = Installer::new(library.clone()).unwrap();
        assert!(installer.verify(install).unwrap().valid);
        installer
            .verify_import_contract(install, &second.request(true).qualification)
            .unwrap();
        let mut changed = second.port.clone();
        changed.persistent_file_patterns.clear();
        assert!(
            installer
                .verify_import_contract(
                    install,
                    &InstallQualification::from_port(&changed, Platform::current().unwrap())
                        .unwrap()
                )
                .is_err()
        );
    }
    service.rollback(PORT).unwrap();
    service.collect_user_data(PORT).unwrap();
    let removal = service.preview_removal(PORT).unwrap();
    let authorization = service
        .authorize_removal(PORT, &removal.preview_sha256)
        .unwrap();
    service.remove(PORT, &authorization.token).unwrap();
    let installed = second.install(&library, true).await;
    service
        .restore_user_data_to(&second.port, &installed.path)
        .unwrap();
    assert_eq!(
        fs::read(installed.path.join("profile_bob.sav")).unwrap(),
        b"older synthetic save"
    );
    let installer = Installer::new(library).unwrap();
    fs::write(
        installed.path.join("profile_bob.sav.exe"),
        b"unexpected code",
    )
    .unwrap();
    assert!(!installer.verify(&installed).unwrap().valid);
    fs::write(
        installed.path.join(&installed.selected_executable),
        b"changed executable",
    )
    .unwrap();
    assert!(installer.verify_critical(&installed).is_err());
}

#[tokio::test]
async fn runtime_only_updates_stage_reuse_and_rollback_with_their_exact_bytes() {
    let root = tempfile::tempdir().unwrap();
    let library = Library::open(root.path()).unwrap();
    let first = Fixture::new(b"runtime one", false);
    let old = first.install(&library, true).await;
    fs::write(old.path.join("isos.portcove-source.json"), b"{}").unwrap();
    assert!(
        Installer::new(library.clone())
            .unwrap()
            .verify(&old)
            .unwrap()
            .valid
    );
    fs::write(old.path.join("unknown.portcove-source.json"), b"{}").unwrap();
    assert!(
        !Installer::new(library.clone())
            .unwrap()
            .verify(&old)
            .unwrap()
            .valid
    );
    fs::remove_file(old.path.join("unknown.portcove-source.json")).unwrap();

    let second = Fixture::new(b"runtime two", false);
    let service = second.service(library.clone());
    let check = service.check_update(PORT).await.unwrap();
    assert!(check.update_available);
    assert_eq!(check.installed_artifact.as_ref(), Some(&old.artifact));
    assert_ne!(check.installed_runtime, check.required_runtime);
    let plan = service.plan_install(PORT, None).await.unwrap();
    assert_eq!(plan.action, InstallPlanAction::Download);
    assert_eq!(
        plan.download_bytes,
        plan.release.asset.size + plan.bundled_runtime.unwrap().asset.size
    );
    let new = second.install(&library, false).await;
    assert_ne!(old.path, new.path);
    assert_eq!(old.artifact, new.artifact);
    assert_eq!(
        service.plan_install(PORT, None).await.unwrap().action,
        InstallPlanAction::UseStaged
    );
    assert_eq!(
        service
            .update(PORT, None, None, true, |_| {})
            .await
            .unwrap()
            .id,
        new.id
    );
    assert_eq!(service.rollback(PORT).unwrap().id, old.id);
    assert_eq!(
        service.plan_install(PORT, None).await.unwrap().action,
        InstallPlanAction::ReuseRetained
    );
    assert_eq!(
        service
            .update(PORT, None, None, true, |_| {})
            .await
            .unwrap()
            .id,
        new.id
    );
    fs::write(
        old.path.join("jdk25/lib/modules"),
        b"modified extensionless runtime data",
    )
    .unwrap();
    assert!(service.rollback(PORT).is_err());
    assert_eq!(service.status(PORT).unwrap().active.unwrap().id, new.id);
    fs::write(new.path.join("libs/game.jar"), b"modified Java game code").unwrap();
    assert!(
        Installer::new(library.clone())
            .unwrap()
            .verify_critical(&new)
            .is_err()
    );
    fs::write(new.path.join("libs/game.jar"), b"synthetic game code").unwrap();
    fs::write(
        new.path.join("jdk25/lib/injected"),
        b"unrecorded executable input",
    )
    .unwrap();
    assert!(
        Installer::new(library)
            .unwrap()
            .verify_critical(&new)
            .is_err()
    );
}

#[tokio::test]
async fn runtime_failure_or_cancellation_never_publishes_a_partial_install() {
    let root = tempfile::tempdir().unwrap();
    let library = Library::open(root.path()).unwrap();
    let first = Fixture::new(b"old", false);
    let old = first.install(&library, true).await;
    fs::create_dir_all(library.user_dir(PORT)).unwrap();
    fs::write(library.user_dir(PORT).join("save"), b"existing save").unwrap();
    for failure in ["checksum", "collision", "cancel", "missing executable"] {
        let mut fixture = Fixture::new(b"candidate", failure == "collision");
        if failure == "checksum" {
            fixture
                .port
                .bundled_runtime
                .values_mut()
                .next()
                .unwrap()
                .asset
                .sha256 = "0".repeat(64);
        }
        if failure == "missing executable" {
            fixture
                .port
                .bundled_runtime
                .values_mut()
                .next()
                .unwrap()
                .executable = "absent/java".into();
        }
        let service = fixture.service(library.clone());
        let (activity, operation) = service
            .begin_cancellable_activity(
                ActivityOperation::Install,
                ActivityTargetKind::Port,
                Some(PORT),
            )
            .unwrap();
        let error = Installer::new(library.clone()).unwrap().install(fixture.request(true), &operation, |event| {
            if failure == "cancel" && matches!(&event.event, OperationEventKind::Message {message, ..} if message.contains("runtime.zip")) {
                service.request_cancellation(&activity.id).unwrap();
            }
        }).await.unwrap_err();
        if failure == "cancel" {
            assert_eq!(error.code, ErrorCode::Cancelled);
        } else {
            assert_eq!(error.code, ErrorCode::Verification);
        }
        service
            .finish_activity::<()>(activity, Err(error))
            .unwrap_err();
        assert_eq!(service.status(PORT).unwrap().active.unwrap().id, old.id);
        assert_eq!(
            fs::read(library.user_dir(PORT).join("save")).unwrap(),
            b"existing save"
        );
        assert_eq!(fs::read_dir(library.staging_dir()).unwrap().count(), 0);
        assert!(
            OperationStore::new(library.clone())
                .all()
                .unwrap()
                .is_empty()
        );
    }
}

#[tokio::test]
async fn adoption_and_metadata_import_preserve_runtime_provenance_and_critical_policy() {
    let root = tempfile::tempdir().unwrap();
    let original = Library::open(root.path().join("original")).unwrap();
    let fixture = Fixture::new(b"runtime", false);
    let downloaded = fixture.install(&original, true).await;
    let library = Library::open(root.path().join("adopted")).unwrap();
    let service = fixture.service(library.clone());
    let preview = service
        .preview_adoption(&downloaded.path, Some(PORT))
        .unwrap();
    let token = service
        .authorize_adoption(&downloaded.path, Some(PORT), &preview.plan_sha256)
        .unwrap();
    let adopted = service
        .adopt(&downloaded.path, Some(PORT), &token.token)
        .unwrap();
    assert_eq!(
        adopted.runtime.as_ref().unwrap().origin,
        RuntimeOrigin::AdoptedTree
    );
    assert_ne!(adopted.runtime, downloaded.runtime);
    assert!(service.check_update(PORT).await.unwrap().update_available);
    assert!(
        Installer::new(original)
            .unwrap()
            .verify(&downloaded)
            .unwrap()
            .valid
    );
    let metadata = root.path().join("metadata.json");
    service.write_library_metadata(&metadata).unwrap();
    let destination = root.path().join("restored");
    let plan =
        PortcoveService::plan_library_import(&metadata, library.root(), &destination).unwrap();
    PortcoveService::import_library(&metadata, library.root(), &destination, &plan.plan_sha256)
        .unwrap();
    let restored = PortcoveService::new(Library::open(&destination).unwrap()).unwrap();
    let record = restored.status(PORT).unwrap().active.unwrap();
    assert_eq!(record.runtime, adopted.runtime);
    assert!(restored.verify(PORT).unwrap().valid);
    fs::remove_file(
        adopted
            .path
            .join("jdk25")
            .join(&adopted.runtime.as_ref().unwrap().executable),
    )
    .unwrap();
    assert!(
        service
            .status(PORT)
            .unwrap()
            .readiness
            .unwrap()
            .blockers
            .contains(&LaunchBlocker::MissingRuntime)
    );
    assert!(
        service
            .launch_spec(PORT, None)
            .unwrap_err()
            .message
            .contains("verified runtime")
    );
}

#[test]
fn runtime_catalog_rejects_mutable_overlaps_unsafe_paths_unpinned_urls_and_incomplete_platforms() {
    let fixture = Fixture::new(b"runtime", false);
    for case in 0..8 {
        let mut port = fixture.port.clone();
        let runtime = port.bundled_runtime.values_mut().next().unwrap();
        match case {
            0 => runtime.target_directory = "../runtime".into(),
            1 => runtime.archive_root = "../vendor".into(),
            2 => runtime.executable = "bin/../java".into(),
            3 => runtime.asset.url = "http://example.invalid/runtime.zip".into(),
            4 => runtime.asset.sha256.clear(),
            5 => runtime.asset.size = 0,
            6 => port.persistent_paths.push("JDK25/lib".into()),
            _ => port.platforms.push(Platform::LinuxX86_64),
        }
        assert!(crate::runtime::validate(&port).is_err(), "case {case}");
    }
}

#[tokio::test]
async fn runtime_follows_a_nested_working_directory_and_rejects_resolved_mutable_aliases() {
    let root = tempfile::tempdir().unwrap();
    let library = Library::open(root.path().join("valid")).unwrap();
    let mut fixture = Fixture::new(b"runtime", false);
    fixture.port.adapter = crate::AdapterKind::N64RecompPortable;
    fixture.port.runtime_subdirectory = Some("bundle".into());
    fixture.port.persistent_paths = vec!["bundle/user".into()];
    fixture.port.source_profile = None;
    fixture.port.runtime_source_filename = None;
    fixture.port.runtime_source_materialization = None;
    let platform = Platform::current().unwrap();
    let game = archive(&[(
        &format!("bundle/{}", fixture.port.executable_hints[&platform][0]),
        b"game",
    )]);
    let spec = fixture.port.bundled_runtime.get_mut(&platform).unwrap();
    let runtime = archive(&[(&format!("vendor-root/{}", spec.executable), b"runtime")]);
    spec.asset = asset("runtime.zip", &runtime);
    fixture.release.asset = asset("game.zip", &game);
    fixture.server = Archives::new(BTreeMap::from([
        ("game.zip".into(), game),
        ("runtime.zip".into(), runtime),
    ]));
    let install = fixture.install(&library, true).await;
    assert!(crate::runtime::ready(&fixture.port, platform, &install));
    assert!(install.path.join("bundle/jdk25").is_dir());
    assert!(!install.path.join("jdk25").exists());
    fixture.port.persistent_paths = vec!["BUNDLE/JDK25".into()];
    let destination = Library::open(root.path().join("overlap")).unwrap();
    let error = Installer::new(destination)
        .unwrap()
        .install(
            fixture.request(true),
            &OperationCoordinator::new("install", None),
            |_| {},
        )
        .await
        .unwrap_err();
    assert!(error.message.contains("overlaps resolved persistent data"));
}
