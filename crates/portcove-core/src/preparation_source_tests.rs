use super::*;
use crate::{
    InstallQualification, InstallRequest, LaunchStdio, OperationCoordinator, PortcoveService,
    PreparationOptions, ReleaseAsset, ReleaseChannel, ResolvedRelease,
};
use std::{
    io::{Cursor, Read, Write},
    path::PathBuf,
};

const PORT: &str = "g-diffuser";
const FILES: [(&str, &[u8]); 3] = [
    ("baserom.us.rev0.z64", &[0x80, 0x37, 0x12, 0x40, 1, 2, 3, 4]),
    ("baserom.translated.ek.ndd", b"owned expansion"),
    ("N64DDIPLROM.n64", b"owned IPL"),
];

struct Fixture {
    _temporary: tempfile::TempDir,
    service: PortcoveService,
    source: SourceRecord,
    probe: PathBuf,
    port_id: &'static str,
}

impl Fixture {
    fn new(zip_source: bool) -> Self {
        Self::with_port(PORT, zip_source)
    }

    fn with_port(port_id: &'static str, zip_source: bool) -> Self {
        eprintln!("source fixture: temporary library");
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        eprintln!("source fixture: catalog projection");
        let mut document = Catalog::embedded().unwrap().authoritative_document();
        document.ports.retain(|port| port.id == port_id);
        let host = Platform::current().unwrap();
        let port = &mut document.ports[0];
        port.platforms = vec![host];
        port.automated_tested_platforms.clear();
        port.manually_validated_platforms.clear();
        port.executable_hints = std::collections::BTreeMap::from([(
            host,
            vec![if cfg!(windows) {
                "game.exe".into()
            } else {
                "game".into()
            }],
        )]);
        port.persistent_paths.clear();
        port.runtime_mutable_paths.extend([
            "launch-arguments".into(),
            "launch-environment".into(),
            "launch-directory".into(),
        ]);
        let profile_id = port.source_profile.clone().unwrap();
        let source_catalog = document.source_catalog.as_mut().unwrap();
        source_catalog.qualification.clear();
        source_catalog
            .contracts
            .retain(|contract| contract.port_id == port_id);
        let profile = source_catalog
            .identities
            .iter_mut()
            .find(|profile| profile.id == profile_id)
            .unwrap();
        let iso = b"synthetic normalized GameCube ISO";
        for variant in &mut profile.variants {
            for representation in &mut variant.representations {
                if let crate::SourceRepresentationKind::GamecubeNormalizedIso { identities } =
                    &mut representation.kind
                {
                    use sha1::Digest;
                    identities[0].sha1 = Some(hex::encode(sha1::Sha1::digest(iso)));
                    identities[0].sha256 = Some(crate::signed_catalog::digest(iso));
                }
                if let crate::SourceRepresentationKind::FileSet { members } =
                    &mut representation.kind
                {
                    for (member, (_, bytes)) in members.iter_mut().zip(FILES) {
                        member.identities = vec![crate::DigestIdentity {
                            scope: crate::DigestScope::FileSetMember,
                            sha1: None,
                            sha256: Some(crate::signed_catalog::digest(bytes)),
                            crc32: None,
                        }];
                    }
                }
            }
        }
        eprintln!("source fixture: validate synthetic catalog");
        let catalog = Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap();
        let source = temporary
            .path()
            .join(if port_id == "animal-crossing-pc-port" {
                "game.iso"
            } else if zip_source {
                "originals.zip"
            } else {
                "originals"
            });
        if port_id == "animal-crossing-pc-port" {
            fs::write(&source, iso).unwrap();
        } else if zip_source {
            let mut writer = zip::ZipWriter::new(fs::File::create(&source).unwrap());
            for (name, bytes) in FILES {
                writer
                    .start_file(name, zip::write::SimpleFileOptions::default())
                    .unwrap();
                writer.write_all(bytes).unwrap();
            }
            writer.finish().unwrap();
        } else {
            fs::create_dir(&source).unwrap();
            for (name, bytes) in FILES {
                fs::write(source.join(name), bytes).unwrap();
            }
        }
        eprintln!("source fixture: service open");
        let mut service = PortcoveService::new(library).unwrap();
        service.replace_catalog_for_test(catalog);
        eprintln!("source fixture: register originals");
        let source = service.register_source(&profile_id, &source).unwrap();
        eprintln!("source fixture: native probe");
        let probe = crate::test_fixture::build_probe(temporary.path());
        eprintln!("source fixture: ready");
        Self {
            _temporary: temporary,
            service,
            source,
            probe,
            port_id,
        }
    }

    fn options(&self) -> PreparationOptions {
        PreparationOptions {
            target: Platform::current().unwrap(),
            mode: PreparationMode::Default,
        }
    }

    async fn install(&self, seal: bool) -> InstallRecord {
        self.install_with_faults(
            seal,
            std::sync::Arc::new(crate::operation::NoLifecycleFaults),
        )
        .await
        .unwrap()
    }

    async fn install_with_faults(
        &self,
        seal: bool,
        faults: std::sync::Arc<dyn crate::operation::LifecycleFaultInjector>,
    ) -> Result<InstallRecord> {
        eprintln!("source install: package fixture");
        let host = Platform::current().unwrap();
        let name = &self
            .service
            .catalog()
            .port(self.port_id)
            .unwrap()
            .executable_hints[&host][0];
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .start_file(
                name,
                zip::write::SimpleFileOptions::default().unix_permissions(0o755),
            )
            .unwrap();
        writer.write_all(&fs::read(&self.probe).unwrap()).unwrap();
        let bytes = writer.finish().unwrap().into_inner();
        let digest = crate::signed_catalog::digest(&bytes);
        let size = bytes.len() as u64;
        let mut qualification =
            InstallQualification::from_catalog(self.service.catalog(), self.port_id, host).unwrap();
        eprintln!("source install: qualification");
        if seal {
            qualification = qualification
                .with_runtime_source(Some(&self.source))
                .unwrap();
        }
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        if std::time::Instant::now() >= deadline {
                            return;
                        }
                        std::thread::sleep(std::time::Duration::from_millis(10));
                    }
                    Err(error) => panic!("owned fixture server failed: {error}"),
                }
            };
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(10)))
                .unwrap();
            let _ = stream.read(&mut [0; 4096]);
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                bytes.len()
            )
            .unwrap();
            stream.write_all(&bytes).unwrap();
        });
        eprintln!("source install: execute");
        let result = Installer::with_faults(self.service.library().clone(), faults)
            .unwrap()
            .install(
                InstallRequest {
                    port_id: self.port_id.into(),
                    output_root: self.service.library().versions_dir().join(self.port_id),
                    release: ResolvedRelease {
                        version: "owned-fixture".into(),
                        channel: ReleaseChannel::Stable,
                        published_at: None,
                        asset: ReleaseAsset {
                            name: "owned-fixture.zip".into(),
                            url: format!("http://{address}/owned-fixture.zip"),
                            sha256: digest,
                            size,
                        },
                    },
                    activate: true,
                    managed: None,
                    qualification,
                },
                &OperationCoordinator::new("install", None),
                |_| {},
            )
            .await;
        eprintln!("source install: finished: {:?}", result.as_ref().err());
        server.join().unwrap();
        result
    }

    fn replay_old_materialization(&self, install: &InstallRecord) {
        crate::adapter::AdapterRegistry
            .get(AdapterKind::StagedSourcePortable)
            .prepare_launch(
                self.service.library(),
                self.service.catalog().port(self.port_id).unwrap(),
                Platform::current().unwrap(),
                &install.path,
                Some(&self.source.path),
            )
            .unwrap();
    }

    fn run_preparation(&self) -> Result<InstallRecord> {
        eprintln!("source preparation: plan");
        let plan = self
            .service
            .plan_preparation(self.port_id, self.options())?;
        assert_eq!(plan.format_version, 3);
        assert!(plan.inputs.setup_tool.is_none());
        let authorization =
            self.service
                .authorize_preparation(self.port_id, self.options(), &plan.plan_sha256)?;
        self.service
            .prepare(self.port_id, self.options(), &authorization.token, |_| {})
    }
}

#[test]
fn source_only_inventory_excludes_existing_mutable_and_managed_owners() {
    let catalog = Catalog::embedded().unwrap();
    let mut ports = catalog
        .ports()
        .iter()
        .filter(|port| eligible(port))
        .map(|port| port.id.as_str())
        .collect::<Vec<_>>();
    ports.sort();
    assert_eq!(ports, ["animal-crossing-pc-port", "g-diffuser", "openpete"]);
}

async fn assert_source_only_install_survives_two_launches(zip_source: bool) {
    let fixture = Fixture::new(zip_source);
    let install = fixture.install(true).await;
    let manifest = fs::read(install.path.join(".portcove-manifest.json")).unwrap();
    assert_eq!(
        Installer::new(fixture.service.library().clone())
            .unwrap()
            .retained_preparation_mode(&install)
            .unwrap(),
        Some(PreparationMode::SourceOnly)
    );
    let sidecar = fs::read(install.path.join(RECEIPT)).unwrap();
    for _ in 0..2 {
        let outcome = fixture
            .service
            .supervise_launch(
                PORT,
                None,
                &["--observe-launch".into()],
                LaunchStdio::Null,
                |_| {},
            )
            .unwrap();
        assert!(outcome.successful);
        assert!(fixture.service.verify(PORT).unwrap().valid);
    }
    assert_eq!(
        fs::read(install.path.join(".portcove-manifest.json")).unwrap(),
        manifest
    );
    assert_eq!(fs::read(install.path.join(RECEIPT)).unwrap(), sidecar);
    fs::write(install.path.join(FILES[0].0), b"modified sealed original").unwrap();
    assert!(!fixture.service.verify(PORT).unwrap().valid);
    assert!(fixture.service.prepare_launch(PORT, None).is_err());
}

#[tokio::test]
async fn source_only_directory_install_survives_two_launches_and_full_verify() {
    assert_source_only_install_survives_two_launches(false).await;
}

#[tokio::test]
async fn source_only_zip_install_survives_two_launches_and_full_verify() {
    assert_source_only_install_survives_two_launches(true).await;
}

#[tokio::test]
async fn source_only_review_repairs_historical_extras_but_refuses_unrelated_changes() {
    let fixture = Fixture::new(false);
    let original = fixture.install(false).await;
    fixture.replay_old_materialization(&original);
    assert!(!fixture.service.verify(PORT).unwrap().valid);
    let before = crate::library_transfer::reviewed_tree(&original.path).unwrap();
    fs::write(original.path.join("unrelated.bin"), b"unowned addition").unwrap();
    assert!(
        fixture
            .service
            .plan_preparation(PORT, fixture.options())
            .is_err()
    );
    fs::remove_file(original.path.join("unrelated.bin")).unwrap();
    let prepared = fixture.run_preparation().unwrap();
    assert_ne!(original.id, prepared.id);
    assert_eq!(
        crate::library_transfer::reviewed_tree(&original.path).unwrap(),
        before
    );
    assert!(fixture.service.verify(PORT).unwrap().valid);
    assert!(fixture.service.prepare_launch(PORT, None).is_ok());
}

#[tokio::test]
async fn source_only_recovery_refuses_original_changes_before_publication() {
    use crate::operation::{LifecycleFaultInjector, LifecycleFaultPoint, OperationStore};
    struct Interrupt;
    impl LifecycleFaultInjector for Interrupt {
        fn check(&self, point: LifecycleFaultPoint) -> Result<()> {
            if point == LifecycleFaultPoint::PreparationPrepared {
                return Err(PortcoveError::state("owned publication interruption"));
            }
            Ok(())
        }
    }
    let mut fixture = Fixture::new(false);
    let original = fixture.install(false).await;
    let catalog = fixture.service.catalog().clone();
    fixture.service = PortcoveService::with_faults(
        fixture.service.library().clone(),
        std::sync::Arc::new(Interrupt),
    )
    .unwrap();
    fixture.service.replace_catalog_for_test(catalog);
    assert_eq!(
        fixture.run_preparation().unwrap_err().message,
        "owned publication interruption"
    );
    fs::write(
        fixture.source.path.join(FILES[0].0),
        [0x80, 0x37, 0x12, 0x40, 5, 6, 7, 8],
    )
    .unwrap();
    let store = OperationStore::new(fixture.service.library().clone());
    let mut journal = store.all().unwrap().remove(0);
    assert!(crate::preparation::recover(&fixture.service, &store, &mut journal).is_err());
    assert_eq!(
        fixture.service.status(PORT).unwrap().active.unwrap().id,
        original.id
    );
    assert!(journal.paths.staging.unwrap().join("payload").is_dir());
}

#[tokio::test]
async fn source_only_gamecube_install_seals_the_nested_iso() {
    let fixture = Fixture::with_port("animal-crossing-pc-port", false);
    let install = fixture.install(true).await;
    let port = fixture.service.catalog().port(fixture.port_id).unwrap();
    let output = install
        .path
        .join(port.runtime_source_filename.as_ref().unwrap());
    assert_eq!(
        fs::read(&output).unwrap(),
        fs::read(&fixture.source.path).unwrap()
    );
    for _ in 0..2 {
        assert!(
            fixture
                .service
                .supervise_launch(
                    fixture.port_id,
                    None,
                    &["--observe-launch".into()],
                    LaunchStdio::Null,
                    |_| {}
                )
                .unwrap()
                .successful
        );
        assert!(fixture.service.verify(fixture.port_id).unwrap().valid);
    }
}

// This exercises the converter boundary; synthetic CHD bytes do not claim disc admission.
#[test]
fn source_only_psx_converter_owns_directory_outputs_and_retains_failure() {
    let temporary = tempfile::tempdir().unwrap();
    let source = temporary.path().join("owned.chd");
    fs::write(&source, b"owned converter input").unwrap();
    let probe = crate::test_fixture::build_probe(temporary.path());
    let tool = super::super::tool_identity(probe, crate::ChildProcessClass::HostTool).unwrap();
    let catalog = Catalog::embedded().unwrap();
    let port = catalog.port("openpete").unwrap();
    let inputs = SourcePreparation {
        format_version: 1,
        source: SourceRecord {
            profile_id: port.source_profile.clone().unwrap(),
            path: source.clone(),
            sha256: String::new(),
            size: 21,
            storage_sha256: String::new(),
            storage_size: 21,
            updated_at: 1,
            observed_identity: None,
        },
        conversion_tool: Some(tool),
        definition_sha256: definition(&catalog, port).unwrap(),
        host: Platform::current().unwrap(),
    };
    let working = temporary.path().join("payload");
    fs::create_dir(&working).unwrap();
    let quiesced = Cell::new(true);
    materialize_single_source(port, &inputs, &working, &|| Ok(()), &quiesced).unwrap();
    let output = working.join(port.runtime_source_filename.as_ref().unwrap());
    assert!(output.join("disc.cue").is_file());
    assert_eq!(
        fs::read(output.join("disc1.bin")).unwrap(),
        b"owned psx track"
    );
    fs::write(source.with_extension("conversion-mode"), "failure").unwrap();
    fs::remove_dir_all(&output).unwrap();
    assert!(materialize_single_source(port, &inputs, &working, &|| Ok(()), &quiesced).is_err());
    assert!(working.is_dir());
    assert_eq!(fs::read(&source).unwrap(), b"owned converter input");
    #[cfg(unix)]
    assert!(
        !quiesced.get(),
        "ordinary Unix process groups do not prove escaped-descendant closure"
    );
}

#[test]
fn source_only_materialization_checkpoint_retains_private_payload_on_cancellation() {
    let fixture = Fixture::new(false);
    let catalog = fixture.service.catalog();
    let port = catalog.port(PORT).unwrap();
    let inputs = plan(catalog, port, &fixture.source, Platform::current().unwrap()).unwrap();
    let payload = fixture._temporary.path().join("cancelled-payload");
    fs::create_dir(&payload).unwrap();
    fs::write(payload.join("owned-runtime"), b"preserved runtime").unwrap();
    let cancelled = Cell::new(false);
    let result = materialize(
        catalog,
        port,
        &inputs,
        &payload,
        &payload,
        &|| {
            if payload.join(FILES[0].0).is_file() {
                cancelled.set(true);
                return Err(PortcoveError::new(
                    crate::ErrorCode::Cancelled,
                    "owned cancellation",
                ));
            }
            Ok(())
        },
        &Cell::new(true),
    );
    assert_eq!(result.unwrap_err().code, crate::ErrorCode::Cancelled);
    assert!(cancelled.get());
    assert!(payload.join("owned-runtime").is_file());
    assert!(!payload.join(RECEIPT).exists());
    assert_eq!(
        fs::read(fixture.source.path.join(FILES[0].0)).unwrap(),
        FILES[0].1
    );
}

struct ChangeOriginalAtPublication {
    point: crate::operation::LifecycleFaultPoint,
    path: PathBuf,
}
impl crate::operation::LifecycleFaultInjector for ChangeOriginalAtPublication {
    fn check(&self, point: crate::operation::LifecycleFaultPoint) -> Result<()> {
        if point == self.point {
            fs::write(&self.path, [0x80, 0x37, 0x12, 0x40, 5, 6, 7, 8])?;
        }
        Ok(())
    }
}

async fn assert_fresh_publication_refuses_source_change(
    point: crate::operation::LifecycleFaultPoint,
) {
    let fixture = Fixture::new(false);
    let fault = ChangeOriginalAtPublication {
        point,
        path: fixture.source.path.join(FILES[0].0),
    };
    assert!(
        fixture
            .install_with_faults(true, std::sync::Arc::new(fault))
            .await
            .is_err()
    );
    assert!(fixture.service.library().all_installs().unwrap().is_empty());
    let journals = crate::operation::OperationStore::new(fixture.service.library().clone())
        .all()
        .unwrap();
    assert_eq!(journals.len(), 1);
    let journal = &journals[0];
    let install = journal.install.as_ref().unwrap();
    if point == crate::operation::LifecycleFaultPoint::InstallPublished {
        assert!(install.path.is_dir());
    } else {
        assert!(!install.path.exists());
        assert!(
            journal
                .paths
                .staging
                .as_ref()
                .unwrap()
                .join("payload")
                .is_dir()
        );
    }
}

#[tokio::test]
async fn source_only_fresh_install_rechecks_original_before_rename() {
    assert_fresh_publication_refuses_source_change(
        crate::operation::LifecycleFaultPoint::InstallReadyToPublish,
    )
    .await;
}
#[tokio::test]
async fn source_only_fresh_install_rechecks_original_before_registration() {
    assert_fresh_publication_refuses_source_change(
        crate::operation::LifecycleFaultPoint::InstallPublished,
    )
    .await;
}

#[test]
fn source_only_owner_refuses_executable_metadata_and_overlapping_outputs() {
    let catalog = Catalog::embedded().unwrap();
    let original = catalog.port(PORT).unwrap();
    assert!(eligible(original));
    for target in [
        "GAME.EXE",
        "bin",
        ".portcove-manifest.json",
        RECEIPT,
        "baserom.us.rev0.z64.portcove-source.json",
        "baserom.translated.ek.ndd",
    ] {
        let mut port = original.clone();
        port.executable_hints.insert(
            Platform::current().unwrap(),
            vec!["game.exe".into(), "bin/game.exe".into()],
        );
        port.runtime_source_set[0].destination = target.into();
        assert!(!eligible(&port), "source ownership must refuse {target}");
    }
    let mut port = original.clone();
    port.runtime_mutable_paths
        .push(original.runtime_source_set[0].destination.clone());
    assert!(!eligible(&port));
}
