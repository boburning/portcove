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

// Generic runtime lifecycle checks need one valid source/port graph, not live titles.
// Adoption, import, launch-policy and real-catalog validation keep embedded fixtures.
fn runtime_catalog(port: Option<&PortDefinition>) -> Catalog {
    let platform = Platform::current().unwrap();
    let key = serde_json::to_value(platform)
        .unwrap()
        .as_str()
        .unwrap()
        .to_owned();
    let executable = if platform == Platform::WindowsX86_64 {
        "launch.bat"
    } else {
        "launch"
    };
    let java = if platform == Platform::WindowsX86_64 {
        "bin/java.exe"
    } else {
        "bin/java"
    };
    let mut document = serde_json::json!({
        "schema_version": 2,
        "source_catalog": {
            "evidence": [{
                "id": "runtime-fixture-bytes", "role": "byte_identity",
                "authority": "Synthetic runtime fixture", "authority_ref": "fixture-1",
                "reviewed_at": "2026-10-02", "claim": "Synthetic runtime source identity",
                "immutable_url": "https://example.invalid/fixtures/runtime-source-v1"
            }],
            "identities": [{
                "id": "runtime-fixture-source", "label": "Synthetic runtime source",
                "kind": "optical-disc", "variants": [{
                    "id": "fixture-1", "title": "Synthetic runtime source",
                    "representations": [{
                        "id": "disc-set", "extensions": ["chd"], "kind": "multi-disc-set",
                        "discs": (1..=4).map(|index| serde_json::json!({
                            "id": format!("disc-{index}"), "label": format!("Synthetic disc {index}"),
                            "track_counts": [1], "volume_ids": [format!("FIXTURE{index}")],
                            "identities": []
                        })).collect::<Vec<_>>(),
                        "evidence_ids": ["runtime-fixture-bytes"]
                    }], "evidence_ids": ["runtime-fixture-bytes"]
                }]
            }],
            "contracts": [{
                "id": "runtime-fixture-game", "port_id": PORT, "role": "game",
                "profile_id": "runtime-fixture-source", "admission_mode": "enforced",
                "supported_variant_ids": ["fixture-1"], "evidence_ids": ["runtime-fixture-bytes"],
                "authority_ref": "fixture-1", "reviewed_at": "2026-10-02",
                "immutable_review_url": "https://example.invalid/fixtures/runtime-source-v1"
            }], "validators": []
        },
        "ports": [{
            "id": PORT, "name": "Synthetic bundled runtime", "summary": "Runtime lifecycle fixture",
            "project_url": "https://example.invalid/fixtures/runtime", "support_tier": "rolling",
            "channels": ["rolling"], "platforms": [platform], "adapter": "staged-source-portable",
            "release": {"repository": "fixture/runtime", "rolling_tag": "fixture"},
            "source_profile": "runtime-fixture-source", "runtime_source_filename": "isos",
            "runtime_source_materialization": "psx-raw-set",
            "launch_from_install_root": true,
            "executable_hints": {(key.clone()): [executable]},
            "persistent_paths": ["saves", "mods", "isos", "files", "config.dcnf", "config.conf",
                "launch.conf", "update_log.txt", "debug.log", "debug-updater.log"],
            "bundled_runtime": {(key): {
                "asset": {"name": "runtime.zip", "url": "https://example.invalid/runtime.zip",
                    "size": 1, "sha256": "a".repeat(64)},
                "archive_root": "vendor-root", "target_directory": "jdk25", "executable": java
            }}
        }]
    });
    if let Some(port) = port {
        document["ports"][0] = serde_json::to_value(port).unwrap();
        if port.source_profile.is_none() {
            document["source_catalog"]["contracts"] = serde_json::json!([]);
        }
    }
    Catalog::from_json(&document.to_string()).unwrap()
}

fn runtime_qualification(port: &PortDefinition) -> crate::InstallQualification {
    crate::InstallQualification::from_catalog(
        &runtime_catalog(Some(port)),
        &port.id,
        Platform::current().unwrap(),
    )
    .unwrap()
}

#[test]
fn generic_runtime_fixture_retains_only_its_valid_source_graph() {
    let catalog = runtime_catalog(None);
    assert_eq!(catalog.ports().len(), 1);
    assert_eq!(catalog.document().source_profiles.len(), 1);
    let source = catalog.source_catalog().unwrap();
    assert_eq!(source.identities.len(), 1);
    assert_eq!(source.contracts.len(), 1);
    assert_eq!(source.evidence.len(), 1);
    let port = catalog.port(PORT).unwrap();
    assert_eq!(
        port.runtime_source_materialization,
        Some(crate::RuntimeSourceMaterialization::PsxRawSet)
    );
    assert_eq!(
        catalog
            .source_profile("runtime-fixture-source")
            .unwrap()
            .disc
            .as_ref()
            .unwrap()
            .discs
            .len(),
        4
    );
    let retained = crate::installed_contract::InstalledContract::capture(&catalog, PORT).unwrap();
    assert_eq!(
        serde_json::to_value(retained.catalog(PORT).unwrap().authoritative_document()).unwrap(),
        serde_json::to_value(catalog.authoritative_document()).unwrap()
    );
    runtime_qualification(port);

    let mut invalid = serde_json::to_value(catalog.authoritative_document()).unwrap();
    invalid["source_catalog"]["contracts"][0]["profile_id"] = "missing-source".into();
    assert!(Catalog::from_json(&invalid.to_string()).is_err());
    let mut invalid = serde_json::to_value(catalog.authoritative_document()).unwrap();
    invalid["source_catalog"]["identities"][0]["unknown_fixture_field"] = true.into();
    assert!(Catalog::from_json(&invalid.to_string()).is_err());
}

#[test]
fn generic_runtime_service_does_not_inherit_unrelated_embedded_catalog_entries() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path()).unwrap();
    let fixture = Fixture::new(b"runtime", false);
    let service = fixture.service(library);
    assert_eq!(service.catalog.ports().len(), 1);
    assert_eq!(service.catalog.ports()[0].id, PORT);
    assert_eq!(service.catalog.document().source_profiles.len(), 1);
    assert_eq!(service.catalog.source_catalog().unwrap().contracts.len(), 1);
    assert_eq!(
        service.catalog.port(PORT).unwrap().bundled_runtime,
        fixture.port.bundled_runtime
    );
    // The real-catalog consumer route remains deliberately distinct.
    let real = Fixture::real(b"runtime", false);
    let library = Library::open(temporary.path().join("real")).unwrap();
    assert_eq!(
        real.service(library).catalog.ports().len(),
        Catalog::embedded().unwrap().ports().len()
    );
}

struct Fixture {
    server: Archives,
    port: PortDefinition,
    release: ResolvedRelease,
}

impl Fixture {
    fn new(runtime_bytes: &[u8], game_extra: bool) -> Self {
        eprintln!("runtime fixture: prepare archives");
        Self::from_port(
            runtime_bytes,
            game_extra,
            runtime_catalog(None).port(PORT).unwrap().clone(),
        )
    }

    fn real(runtime_bytes: &[u8], game_extra: bool) -> Self {
        Self::from_port(
            runtime_bytes,
            game_extra,
            Catalog::embedded().unwrap().port(PORT).unwrap().clone(),
        )
    }

    fn from_port(runtime_bytes: &[u8], game_extra: bool, mut port: PortDefinition) -> Self {
        let platform = Platform::current().unwrap();
        port.platforms = vec![platform];
        port.automated_tested_platforms
            .retain(|key| *key == platform);
        port.manually_validated_platforms
            .retain(|key| *key == platform);
        port.executable_hints.retain(|key, _| *key == platform);
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

    fn request(&self, library: &Library, activate: bool) -> InstallRequest {
        // Transport is local in this fixture; the catalog admission tests still require HTTPS.
        let mut release = self.release.clone();
        release.asset.url = format!("{}/game.zip", self.server.url);
        InstallRequest {
            port_id: PORT.into(),
            release,
            output_root: library.versions_dir().join(PORT),
            activate,
            managed: None,
            qualification: if self.port.source_profile.as_deref() == Some("runtime-fixture-source")
                || self.port.source_profile.is_none()
            {
                runtime_qualification(&self.port)
            } else {
                crate::test_fixture::retained_qualification(
                    &self.port,
                    Platform::current().unwrap(),
                )
                .unwrap()
            }
            .with_test_runtime_url(format!("{}/runtime.zip", self.server.url)),
        }
    }

    async fn install(&self, library: &Library, activate: bool) -> InstallRecord {
        eprintln!("runtime fixture: install, activate={activate}");
        let installed = Installer::new(library.clone()).unwrap();
        eprintln!("runtime fixture: installed");
        installed
            .install(
                self.request(library, activate),
                &OperationCoordinator::new("install", None),
                |_| {},
            )
            .await
            .unwrap()
    }

    fn service(&self, library: Library) -> PortcoveService {
        eprintln!("runtime fixture: initialize service");
        let mut service =
            PortcoveService::with_provider(library, Arc::new(FixedRelease(self.release.clone())))
                .unwrap();
        service.catalog = if self.port.source_profile.as_deref() == Some("runtime-fixture-source")
            || self.port.source_profile.is_none()
        {
            runtime_catalog(Some(&self.port))
        } else {
            let mut document = service.catalog.document().clone();
            *document
                .ports
                .iter_mut()
                .find(|port| port.id == PORT)
                .unwrap() = self.port.clone();
            Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap()
        };
        eprintln!("runtime fixture: service ready");
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
async fn named_saves_follow_activation_and_rollback_including_deleted_slots() {
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
}

#[tokio::test]
async fn named_save_restore_updates_every_version_and_preserves_import_policy() {
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
    fs::write(staged.path.join("profile_extra.sav"), b"second slot").unwrap();
    fs::write(staged.path.join(LAUNCH_MARKER), b"1").unwrap();
    service.collect_user_data(PORT).unwrap();
    eprintln!("named save restore: authorize restoration");
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
    eprintln!("named save restore: verify every version");
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
            .verify_import_contract(install, &second.request(&library, true).qualification)
            .unwrap();
        let mut changed = second.port.clone();
        changed.persistent_file_patterns.clear();
        assert!(
            installer
                .verify_import_contract(install, &runtime_qualification(&changed))
                .is_err()
        );
    }
}

#[tokio::test]
async fn named_saves_survive_reinstallation_without_weakening_executable_policy() {
    let root = tempfile::tempdir().unwrap();
    let library = Library::open(root.path()).unwrap();
    let patterns = vec![crate::PersistentFilePattern {
        prefix: "profile_".into(),
        suffix: ".sav".into(),
    }];
    let mut first = Fixture::new(b"runtime one", false);
    first.port.persistent_file_patterns = patterns.clone();
    let old = first.install(&library, true).await;
    let second = first;
    let service = second.service(library.clone());
    fs::write(old.path.join("profile_bob.sav"), b"older synthetic save").unwrap();
    fs::write(old.path.join(LAUNCH_MARKER), b"1").unwrap();
    // Removal collects launched saves; an explicit pre-collection duplicated it.
    eprintln!("named save reinstall: remove");
    let removal = service.preview_removal(PORT).unwrap();
    let authorization = service
        .authorize_removal(PORT, &removal.preview_sha256)
        .unwrap();
    service.remove(PORT, &authorization.token).unwrap();
    let installed = second.install(&library, true).await;
    eprintln!("named save reinstall: restore and verify");
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
    assert!(
        installer
            .verify_critical(&installed, &runtime_qualification(&second.port))
            .is_err()
    );
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
            .verify_critical(&new, &runtime_qualification(&second.port))
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
            .verify_critical(&new, &runtime_qualification(&second.port))
            .is_err()
    );
}

async fn assert_runtime_failure_preserves_install(failure: &str) {
    let root = tempfile::tempdir().unwrap();
    let library = Library::open(root.path()).unwrap();
    let first = Fixture::new(b"old", false);
    let old = first.install(&library, true).await;
    fs::create_dir_all(library.user_dir(PORT)).unwrap();
    fs::write(library.user_dir(PORT).join("save"), b"existing save").unwrap();
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
    let error = Installer::new(library.clone()).unwrap().install(fixture.request(&library, true), &operation, |event| {
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

#[tokio::test]
async fn runtime_checksum_preserves_the_active_install() {
    assert_runtime_failure_preserves_install("checksum").await;
}

#[tokio::test]
async fn package_checksum_refusal_preserves_active_install_and_user_data() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("disposable library")).unwrap();
    let fixture = Fixture::new(b"runtime", false);
    let installed = fixture.install(&library, true).await;
    let save = library.user_dir(PORT).join("existing save");
    fs::create_dir_all(save.parent().unwrap()).unwrap();
    fs::write(&save, b"preserve these bytes").unwrap();
    let service = fixture.service(library.clone());
    let (activity, operation) = service
        .begin_cancellable_activity(
            ActivityOperation::Install,
            ActivityTargetKind::Port,
            Some(PORT),
        )
        .unwrap();
    let mut request = fixture.request(&library, true);
    request.release.version = "invalid-checksum-candidate".into();
    request.release.asset.sha256 = "0".repeat(64);
    let result = Installer::new(library.clone())
        .unwrap()
        .install(request, &operation, |_| {})
        .await;
    let error = service.finish_activity(activity, result).unwrap_err();
    assert_eq!(error.code, ErrorCode::Verification);

    let reopened = fixture.service(Library::open(library.root()).unwrap());
    assert_eq!(
        reopened.status(PORT).unwrap().active.unwrap().id,
        installed.id
    );
    assert_eq!(reopened.library().all_installs().unwrap().len(), 1);
    assert_eq!(fs::read(&save).unwrap(), b"preserve these bytes");
    assert_eq!(fs::read_dir(library.staging_dir()).unwrap().count(), 0);
    assert!(
        OperationStore::new(library.clone())
            .all()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        library.activities(1).unwrap()[0].status,
        ActivityStatus::Failed
    );
    assert!(
        Installer::new(library)
            .unwrap()
            .verify(&installed)
            .unwrap()
            .valid
    );
}

#[tokio::test]
async fn runtime_collision_preserves_the_active_install() {
    assert_runtime_failure_preserves_install("collision").await;
}

#[tokio::test]
async fn runtime_cancel_preserves_the_active_install() {
    assert_runtime_failure_preserves_install("cancel").await;
}

#[tokio::test]
async fn runtime_missing_executable_preserves_the_active_install() {
    assert_runtime_failure_preserves_install("missing executable").await;
}

#[tokio::test]
async fn runtime_adoption_changes_provenance_without_mutating_the_downloaded_install() {
    let root = tempfile::tempdir().unwrap();
    let original = Library::open(root.path().join("original")).unwrap();
    let fixture = Fixture::real(b"runtime", false);
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
    assert!(
        Installer::new(original)
            .unwrap()
            .verify(&downloaded)
            .unwrap()
            .valid
    );
}

fn adopted_runtime_fixture() -> (
    tempfile::TempDir,
    Library,
    PortcoveService,
    crate::InstallRecord,
) {
    let root = tempfile::tempdir().unwrap();
    let mut fixture = Fixture::real(b"runtime", false);
    let platform = Platform::current().unwrap();
    // Adoption/import exercises an admitted catalog contract. Keep the other
    // platforms' reviewed declarations instead of the download fixture's
    // deliberately host-only definition.
    let host_runtime = fixture.port.bundled_runtime[&platform].clone();
    fixture.port = Catalog::embedded().unwrap().port(PORT).unwrap().clone();
    fixture.port.bundled_runtime.insert(platform, host_runtime);
    let runtime = &fixture.port.bundled_runtime[&platform];
    let external = root.path().join("external");
    for (relative, bytes) in [
        (
            fixture.port.executable_hints[&platform][0].clone(),
            b"synthetic game launcher".as_slice(),
        ),
        ("libs/game.jar".into(), b"synthetic game code"),
        (
            format!("{}/{}", runtime.target_directory, runtime.executable),
            b"synthetic runtime executable",
        ),
        (
            format!("{}/lib/modules", runtime.target_directory),
            b"runtime",
        ),
    ] {
        let file = external.join(relative);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, bytes).unwrap();
        crate::permissions::normalize_archive_entry(&file, false, true).unwrap();
    }
    let library = Library::open(root.path().join("adopted")).unwrap();
    let service = fixture.service(library.clone());
    let preview = service.preview_adoption(&external, Some(PORT)).unwrap();
    let authorization = service
        .authorize_adoption(&external, Some(PORT), &preview.plan_sha256)
        .unwrap();
    let adopted = service
        .adopt(&external, Some(PORT), &authorization.token)
        .unwrap();
    assert_eq!(
        adopted.runtime.as_ref().unwrap().origin,
        RuntimeOrigin::AdoptedTree
    );
    (root, library, service, adopted)
}

#[test]
fn metadata_import_preserves_adopted_runtime_provenance() {
    let (root, library, service, adopted) = adopted_runtime_fixture();
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
}

#[tokio::test]
async fn adopted_runtime_remains_subject_to_critical_launch_policy() {
    let (_root, _library, service, adopted) = adopted_runtime_fixture();
    assert!(service.check_update(PORT).await.unwrap().update_available);
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
            .prepare_launch(PORT, None)
            .unwrap_err()
            .message
            .contains("verified runtime")
    );
}

#[test]
fn runtime_catalog_rejects_mutable_overlaps_unsafe_paths_unpinned_urls_and_incomplete_platforms() {
    let fixture = Fixture::real(b"runtime", false);
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
    fixture.port.launch_from_install_root = false;
    fixture.port.runtime_subdirectory = Some("bundle".into());
    fixture.port.persistent_paths = vec!["bundle/user".into()];
    fixture.port.source_profile = None;
    fixture.port.presentation = None;
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
    let error = Installer::new(destination.clone())
        .unwrap()
        .install(
            fixture.request(&destination, true),
            &OperationCoordinator::new("install", None),
            |_| {},
        )
        .await
        .unwrap_err();
    assert!(error.message.contains("overlaps resolved persistent data"));
}
