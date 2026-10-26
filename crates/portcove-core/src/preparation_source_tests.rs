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
}

impl Fixture {
    fn new(zip_source: bool) -> Self {
        eprintln!("source fixture: temporary library");
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        eprintln!("source fixture: catalog projection");
        let mut document = Catalog::embedded().unwrap().authoritative_document();
        document.ports.retain(|port| port.id == PORT);
        let host = Platform::current().unwrap();
        let port = &mut document.ports[0];
        port.platforms = vec![host];
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
        let source_catalog = document.source_catalog.as_mut().unwrap();
        source_catalog.qualification.clear();
        source_catalog
            .contracts
            .retain(|contract| contract.port_id == PORT);
        let profile = source_catalog
            .identities
            .iter_mut()
            .find(|profile| profile.id == "g-diffuser-source-set")
            .unwrap();
        for variant in &mut profile.variants {
            for representation in &mut variant.representations {
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
        let source = temporary.path().join(if zip_source {
            "originals.zip"
        } else {
            "originals"
        });
        if zip_source {
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
        let source = service
            .register_source("g-diffuser-source-set", &source)
            .unwrap();
        eprintln!("source fixture: native probe");
        let probe = crate::test_fixture::build_probe(temporary.path());
        eprintln!("source fixture: ready");
        Self {
            _temporary: temporary,
            service,
            source,
            probe,
        }
    }

    fn options(&self) -> PreparationOptions {
        PreparationOptions {
            target: Platform::current().unwrap(),
            mode: PreparationMode::Default,
        }
    }

    async fn install(&self, seal: bool) -> InstallRecord {
        eprintln!("source install: package fixture");
        let host = Platform::current().unwrap();
        let name = &self.service.catalog().port(PORT).unwrap().executable_hints[&host][0];
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
        let mut qualification =
            InstallQualification::from_catalog(self.service.catalog(), PORT, host).unwrap();
        eprintln!("source install: qualification");
        if seal {
            qualification = qualification
                .with_runtime_source(Some(&self.source))
                .unwrap();
        }
        eprintln!("source install: execute");
        let result = Installer::new(self.service.library().clone())
            .unwrap()
            .install(
                InstallRequest {
                    port_id: PORT.into(),
                    output_root: self.service.library().versions_dir().join(PORT),
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
        result.unwrap()
    }

    fn replay_old_materialization(&self, install: &InstallRecord) {
        crate::adapter::AdapterRegistry
            .get(AdapterKind::StagedSourcePortable)
            .prepare_launch(
                self.service.library(),
                self.service.catalog().port(PORT).unwrap(),
                Platform::current().unwrap(),
                &install.path,
                Some(&self.source.path),
            )
            .unwrap();
    }

    fn run_preparation(&self) -> Result<InstallRecord> {
        eprintln!("source preparation: plan");
        let plan = self.service.plan_preparation(PORT, self.options())?;
        assert_eq!(plan.format_version, 3);
        assert!(plan.inputs.setup_tool.is_none());
        let authorization =
            self.service
                .authorize_preparation(PORT, self.options(), &plan.plan_sha256)?;
        self.service
            .prepare(PORT, self.options(), &authorization.token, |_| {})
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
