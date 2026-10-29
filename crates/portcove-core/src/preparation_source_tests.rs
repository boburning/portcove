use super::*;
use crate::{
    InstallQualification, InstallRequest, LaunchStdio, OperationCoordinator, PortcoveService,
    PreparationOptions, ReleaseAsset, ReleaseChannel, ResolvedRelease,
};
use std::{
    io::{Cursor, Write},
    path::PathBuf,
};

const PORT: &str = "g-diffuser";
const NATIVE_PORT: &str = "native-originals-fixture";
const NATIVE_PROFILE: &str = "native-originals-fixture-source";
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
        Self::with_route(port_id, zip_source, false, false)
    }

    fn native(zip_source: bool, wrapped: bool) -> Self {
        Self::with_route(PORT, zip_source, true, wrapped)
    }

    fn with_route(port_id: &'static str, zip_source: bool, native: bool, wrapped: bool) -> Self {
        eprintln!("source fixture: temporary library");
        let temporary = if native {
            tempfile::Builder::new()
                .prefix("native-originals-ü-")
                .tempdir()
                .unwrap()
        } else {
            tempfile::tempdir().unwrap()
        };
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
        if native {
            port.adapter = AdapterKind::NativePortable;
            port.source_environment = None;
            port.launch_arguments.clear();
            port.runtime_mutable_paths.clear();
            port.persistent_paths = vec![
                "profile".into(),
                "launch-arguments".into(),
                "launch-environment".into(),
                "launch-directory".into(),
            ];
            for target in &mut port.runtime_source_set {
                target.destination = format!("originals/{}", target.destination);
                target.materialization = RuntimeSourceMaterialization::Copy;
            }
            if wrapped {
                for hint in port.executable_hints.values_mut().flatten() {
                    *hint = format!("publisher/{hint}");
                }
            }
            if cfg!(windows) {
                port.windows_temp_directory = Some("profile".into());
                port.windows_runtime_path_policy =
                    Some(crate::WindowsRuntimePathPolicy::RelativeFileMaxPath);
            }
        }
        let mut profile_id = port.source_profile.clone().unwrap();
        let source_catalog = document.source_catalog.as_mut().unwrap();
        source_catalog.qualification.clear();
        source_catalog
            .contracts
            .retain(|contract| contract.port_id == port_id);
        // Only this owned fixture's complete source graph participates. Keeping
        // unrelated real-title identities adds no coverage to these operations.
        source_catalog
            .identities
            .retain(|identity| identity.id == profile_id);
        if native {
            port.id = NATIVE_PORT.into();
            port.name = "Native originals fixture".into();
            port.summary = "Owned native originals and profile fixture".into();
            for contract in &mut source_catalog.contracts {
                contract.id = "native-originals-fixture-game".into();
                contract.port_id = NATIVE_PORT.into();
                contract.profile_id = NATIVE_PROFILE.into();
            }
            let identity = source_catalog
                .identities
                .iter_mut()
                .find(|identity| identity.id == profile_id)
                .unwrap();
            identity.id = NATIVE_PROFILE.into();
            identity.label = "Owned synthetic original-file set".into();
            profile_id = NATIVE_PROFILE.into();
            port.source_profile = Some(profile_id.clone());
            let requirement = port
                .presentation
                .as_mut()
                .unwrap()
                .source_requirements
                .iter_mut()
                .find(|requirement| requirement.role == crate::PortSourceRole::Game)
                .unwrap();
            requirement.profile_id = profile_id.clone();
            requirement.label = identity.label.clone();
        }
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
            port_id: if native { NATIVE_PORT } else { port_id },
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
        self.install_mode(seal, true, faults).await
    }

    async fn install_mode(
        &self,
        seal: bool,
        activate: bool,
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
        let mut response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            bytes.len()
        )
        .into_bytes();
        response.extend_from_slice(&bytes);
        let (origin, _requests, server) = crate::test_http::serve_http_bytes(vec![response]);
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
                            url: format!("{origin}/owned-fixture.zip"),
                            sha256: digest,
                            size,
                        },
                    },
                    activate,
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
    assert_eq!(
        ports,
        [
            "animal-crossing-pc-port",
            "blake-stone-aliens-of-gold-bstone",
            "blake-stone-planet-strike-bstone",
            "g-diffuser",
            "openpete"
        ]
    );
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
        MaterializationRoot {
            payload: &payload,
            working: &payload,
            replace_prepared: false,
        },
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
    assert_publication_source_change(Fixture::new(false), point).await;
}

async fn assert_publication_source_change(
    fixture: Fixture,
    point: crate::operation::LifecycleFaultPoint,
) {
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

async fn assert_native6_originals_launch(zip: bool, wrapped: bool) {
    let fixture = Fixture::native(zip, wrapped);
    let install = fixture.install(true).await;
    let working = crate::runtime::working_root(
        fixture.service.catalog().port(NATIVE_PORT).unwrap(),
        &install,
    );
    assert_eq!(
        working,
        if wrapped {
            install.path.join("publisher")
        } else {
            install.path.clone()
        }
    );
    let receipt = fs::read(install.path.join(RECEIPT)).unwrap();
    for (name, bytes) in FILES {
        assert_eq!(
            fs::read(working.join("originals").join(name)).unwrap(),
            bytes
        );
    }
    for _ in 0..2 {
        assert!(
            fixture
                .service
                .supervise_launch(
                    NATIVE_PORT,
                    None,
                    &["--observe-launch".into()],
                    LaunchStdio::Null,
                    |_| {}
                )
                .unwrap()
                .successful
        );
        assert!(fixture.service.verify(NATIVE_PORT).unwrap().valid);
    }
    assert_eq!(fs::read(install.path.join(RECEIPT)).unwrap(), receipt);
    crate::source_inspection::verify_registered(fixture.service.catalog(), &fixture.source)
        .unwrap();
    fs::write(
        working.join("originals").join(FILES[2].0),
        b"changed later member",
    )
    .unwrap();
    assert!(!fixture.service.verify(NATIVE_PORT).unwrap().valid);
    assert!(fixture.service.prepare_launch(NATIVE_PORT, None).is_err());
}

#[tokio::test]
async fn native6_flat_directory_originals_survive_launch_and_full_verify() {
    assert_native6_originals_launch(false, false).await;
}

#[tokio::test]
async fn native6_flat_zip_originals_survive_launch_and_full_verify() {
    assert_native6_originals_launch(true, false).await;
}

#[tokio::test]
async fn native6_wrapped_directory_originals_survive_launch_and_full_verify() {
    assert_native6_originals_launch(false, true).await;
}

#[tokio::test]
async fn native6_wrapped_zip_originals_survive_launch_and_full_verify() {
    assert_native6_originals_launch(true, true).await;
}

#[tokio::test]
async fn native6_wrapped_installed_preparation_preserves_unprepared_runtime() {
    let fixture = Fixture::native(false, true);
    let original = fixture.install(false).await;
    assert!(fixture.service.prepare_launch(NATIVE_PORT, None).is_err());
    let before = crate::library_transfer::reviewed_tree(&original.path).unwrap();
    let prepared = fixture.run_preparation().unwrap();
    assert_ne!(original.id, prepared.id);
    assert_eq!(
        crate::library_transfer::reviewed_tree(&original.path).unwrap(),
        before
    );
    assert!(fixture.service.verify(NATIVE_PORT).unwrap().valid);
    assert!(fixture.service.prepare_launch(NATIVE_PORT, None).is_ok());
    assert!(prepared.path.join("publisher/originals").is_dir());
    assert!(prepared.path.join(RECEIPT).is_file());
}

#[test]
fn native6_materialization_refuses_package_collisions_before_any_copy() {
    let fixture = Fixture::native(false, true);
    let catalog = fixture.service.catalog();
    let port = catalog.port(NATIVE_PORT).unwrap();
    let inputs = plan(catalog, port, &fixture.source, Platform::current().unwrap()).unwrap();
    for collision in [
        "originals/N64DDIPLROM.n64",
        "ORIGINALS/n64ddiplrom.N64",
        "originals/N64DDIPLROM.n64.portcove-source.json",
        "ORIGINALS/",
        "originals/N64DDIPLROM.n64/",
    ] {
        let temporary = tempfile::tempdir().unwrap();
        let payload = temporary.path().join("payload");
        let working = payload.join("publisher");
        fs::create_dir_all(&working).unwrap();
        let executable = port.executable_hints[&Platform::current().unwrap()][0].clone();
        fs::copy(&fixture.probe, payload.join(executable)).unwrap();
        fs::create_dir_all(working.join(collision).parent().unwrap()).unwrap();
        if collision.ends_with('/') {
            fs::create_dir_all(working.join(collision)).unwrap();
        } else {
            fs::write(working.join(collision), b"publisher-owned sentinel").unwrap();
        }
        let before = crate::library_transfer::reviewed_tree(&payload).unwrap();
        assert!(
            materialize(
                catalog,
                port,
                &inputs,
                MaterializationRoot {
                    payload: &payload,
                    working: &working,
                    replace_prepared: false
                },
                &|| Ok(()),
                &Cell::new(true)
            )
            .is_err()
        );
        assert_eq!(
            crate::library_transfer::reviewed_tree(&payload).unwrap(),
            before
        );
    }
}

#[tokio::test]
async fn native6_wrapped_publication_rechecks_original_before_rename_and_registration() {
    for point in [
        crate::operation::LifecycleFaultPoint::InstallReadyToPublish,
        crate::operation::LifecycleFaultPoint::InstallPublished,
    ] {
        assert_publication_source_change(Fixture::native(false, true), point).await;
    }
}

#[test]
fn native6_catalog_refuses_incomplete_sets_and_mutable_original_coordinates() {
    let fixture = Fixture::native(false, true);
    let document = fixture.service.catalog().authoritative_document();
    for change in [
        "missing-member",
        "conversion",
        "mutable-originals",
        "shared-original-parent",
        "legacy-single",
        "manual-marker",
    ] {
        let mut document = document.clone();
        let port = &mut document.ports[0];
        match change {
            "missing-member" => {
                port.runtime_source_set.pop();
            }
            "conversion" => {
                port.runtime_source_set[0].materialization =
                    RuntimeSourceMaterialization::N64BigEndian
            }
            "mutable-originals" => port.persistent_paths.push("originals".into()),
            "shared-original-parent" => port.persistent_paths.push("originals/settings.ini".into()),
            "legacy-single" => port.runtime_source_filename = Some("legacy.dat".into()),
            "manual-marker" => port.setup_marker = Some("ready.dat".into()),
            _ => unreachable!(),
        }
        assert!(
            Catalog::from_json(&serde_json::to_string(&document).unwrap()).is_err(),
            "{change}"
        );
    }
}

#[tokio::test]
async fn native6_mixed_sets_and_same_profile_edition_replacement_cannot_reprepare_player_data() {
    let mut fixture = Fixture::native(false, true);
    let mut document = fixture.service.catalog().authoritative_document();
    let sources = document.source_catalog.as_mut().unwrap();
    let profile = sources
        .identities
        .iter_mut()
        .find(|profile| profile.id == fixture.source.profile_id)
        .unwrap();
    let mut alternate = profile
        .variants
        .iter()
        .find(|variant| !variant.legacy_projection_only)
        .unwrap()
        .clone();
    alternate.id = "owned-alternate-edition".into();
    for representation in &mut alternate.representations {
        let crate::SourceRepresentationKind::FileSet { members } = &mut representation.kind else {
            unreachable!()
        };
        for member in members {
            member.identities = vec![crate::DigestIdentity {
                scope: crate::DigestScope::FileSetMember,
                sha1: None,
                sha256: Some(crate::signed_catalog::digest(b"owned alternate edition")),
                crc32: None,
            }];
        }
    }
    let mut projection = profile
        .variants
        .iter()
        .find(|variant| !variant.legacy_projection_only)
        .unwrap()
        .clone();
    projection.id = "owned-legacy-projection".into();
    projection.legacy_projection_only = true;
    for representation in &mut projection.representations {
        let crate::SourceRepresentationKind::FileSet { members } = &mut representation.kind else {
            unreachable!()
        };
        for member in members {
            member.identities.push(crate::DigestIdentity {
                scope: crate::DigestScope::FileSetMember,
                sha1: None,
                sha256: Some(crate::signed_catalog::digest(b"owned alternate edition")),
                crc32: None,
            });
        }
    }
    profile.variants.push(projection);
    profile.variants.push(alternate);
    for contract in &mut sources.contracts {
        contract
            .supported_variant_ids
            .push("owned-alternate-edition".into());
    }
    let catalog = Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap();
    fixture.service.replace_catalog_for_test(catalog);
    let install = fixture.install(true).await;
    let working = install.path.join("publisher");
    fs::create_dir_all(working.join("profile")).unwrap();
    fs::write(working.join("profile/progress.sav"), b"player choice").unwrap();
    let before = crate::library_transfer::reviewed_tree(&install.path).unwrap();
    fs::write(
        fixture.source.path.join(FILES[1].0),
        b"owned alternate edition",
    )
    .unwrap();
    assert!(
        crate::source_inspection::inspect_with_checkpoint(
            fixture.service.catalog(),
            &fixture.source.profile_id,
            &fixture.source.path,
            &|| Ok(())
        )
        .unwrap()
        .require_admitted_record()
        .is_err()
    );
    for (name, _) in FILES {
        fs::write(fixture.source.path.join(name), b"owned alternate edition").unwrap();
    }
    fixture
        .service
        .register_source(&fixture.source.profile_id, &fixture.source.path)
        .unwrap();
    assert!(
        fixture
            .service
            .plan_preparation(NATIVE_PORT, fixture.options())
            .is_err()
    );
    assert!(fixture.service.prepare_launch(NATIVE_PORT, None).is_err());
    assert_eq!(
        crate::library_transfer::reviewed_tree(&install.path).unwrap(),
        before
    );
    assert_eq!(
        fixture
            .service
            .status(NATIVE_PORT)
            .unwrap()
            .active
            .unwrap()
            .id,
        install.id
    );
}

#[tokio::test]
async fn native6_removal_preserves_profile_and_external_originals() {
    let fixture = Fixture::native(false, true);
    let install = fixture.install(true).await;
    let profile = install.path.join("publisher/profile");
    fs::create_dir_all(&profile).unwrap();
    fs::write(profile.join("settings.ini"), b"owned config choice").unwrap();
    let preview = fixture.service.preview_removal(NATIVE_PORT).unwrap();
    let authorization = fixture
        .service
        .authorize_removal(NATIVE_PORT, &preview.preview_sha256)
        .unwrap();
    fixture
        .service
        .remove(NATIVE_PORT, &authorization.token)
        .unwrap();
    assert!(!install.path.exists());
    assert_eq!(
        fs::read(
            fixture
                .service
                .library()
                .user_dir(NATIVE_PORT)
                .join("profile/settings.ini")
        )
        .unwrap(),
        b"owned config choice"
    );
    crate::source_inspection::verify_registered(fixture.service.catalog(), &fixture.source)
        .unwrap();
}

#[test]
fn native6_canonical_original_and_profile_aliases_require_creating_authority() {
    let fixture = Fixture::native(false, true);
    let port = fixture.service.catalog().port(NATIVE_PORT).unwrap();
    let user = fixture.service.library().user_dir(NATIVE_PORT);
    require_fresh_canonical_data(port, fixture.service.library()).unwrap();
    for relative in ["originals", "ORIGINALS", "profile", "PROFILE"] {
        fs::create_dir_all(user.join(relative)).unwrap();
        assert!(
            require_fresh_canonical_data(port, fixture.service.library()).is_err(),
            "{relative}"
        );
        assert!(user.join(relative).is_dir());
        fs::remove_dir(user.join(relative)).unwrap();
    }
    require_fresh_canonical_data(port, fixture.service.library()).unwrap();
}

#[test]
fn native6_adoption_refuses_populated_empty_and_pattern_player_data_before_copying() {
    let fixture = Fixture::native(false, true);
    let mut port = fixture.service.catalog().port(NATIVE_PORT).unwrap().clone();
    // This guard must work independently of the optional Native5 field.
    port.windows_temp_directory = None;
    port.persistent_file_patterns
        .push(crate::PersistentFilePattern {
            prefix: "screenshot-".into(),
            suffix: ".png".into(),
        });
    for relative in [
        "profile/",
        "PROFILE/",
        "profile/settings.ini",
        "screenshot-001.png",
    ] {
        let temporary = tempfile::tempdir().unwrap();
        let payload = temporary.path().join("payload");
        let working = payload.join("publisher");
        fs::create_dir_all(&working).unwrap();
        let selected = payload.join(&port.executable_hints[&Platform::current().unwrap()][0]);
        fs::copy(&fixture.probe, &selected).unwrap();
        let path = working.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        if relative.ends_with('/') {
            fs::create_dir_all(&path).unwrap();
        } else {
            fs::write(&path, b"unadmitted player data").unwrap();
        }
        let before = crate::library_transfer::reviewed_tree(&payload).unwrap();
        assert!(
            require_pristine_adoption(&port, &payload, &selected).is_err(),
            "{relative}"
        );
        assert_eq!(
            crate::library_transfer::reviewed_tree(&payload).unwrap(),
            before
        );
    }
}

struct InjectCanonicalAtPublication {
    point: crate::operation::LifecycleFaultPoint,
    path: PathBuf,
}
impl crate::operation::LifecycleFaultInjector for InjectCanonicalAtPublication {
    fn check(&self, point: crate::operation::LifecycleFaultPoint) -> Result<()> {
        if point == self.point {
            fs::create_dir_all(&self.path)?;
        }
        Ok(())
    }
}

#[tokio::test]
async fn native6_late_canonical_data_holds_publication_and_already_renamed_recovery() {
    use crate::operation::{LifecycleFaultPoint, OperationStore};
    for (prepared, point, relative) in [
        (
            true,
            LifecycleFaultPoint::InstallReadyToPublish,
            "originals",
        ),
        (true, LifecycleFaultPoint::InstallPublished, "profile"),
        (
            false,
            LifecycleFaultPoint::InstallReadyToPublish,
            "originals",
        ),
        (false, LifecycleFaultPoint::InstallPublished, "profile"),
    ] {
        let fixture = Fixture::native(false, true);
        let canonical = fixture
            .service
            .library()
            .user_dir(NATIVE_PORT)
            .join(relative);
        assert!(
            fixture
                .install_with_faults(
                    prepared,
                    std::sync::Arc::new(InjectCanonicalAtPublication {
                        point,
                        path: canonical.clone()
                    })
                )
                .await
                .is_err()
        );
        assert!(fixture.service.library().all_installs().unwrap().is_empty());
        assert!(canonical.is_dir());
        let store = OperationStore::new(fixture.service.library().clone());
        let mut journal = store.all().unwrap().remove(0);
        let install = journal.install.clone().unwrap();
        if !install.path.exists() {
            let payload = journal.paths.staging.as_ref().unwrap().join("payload");
            fs::create_dir_all(install.path.parent().unwrap()).unwrap();
            crate::durability::rename_noreplace(&payload, &install.path).unwrap();
        }
        let before = crate::library_transfer::reviewed_tree(&install.path).unwrap();
        let phase = journal.phase;
        assert!(
            crate::recovery::recover_published_install(&fixture.service, &store, &mut journal)
                .is_err()
        );
        assert_eq!(journal.phase, phase);
        assert_eq!(
            crate::library_transfer::reviewed_tree(&install.path).unwrap(),
            before
        );
        assert!(fixture.service.library().all_installs().unwrap().is_empty());
        crate::source_inspection::verify_registered(fixture.service.catalog(), &fixture.source)
            .unwrap();
    }
}

#[tokio::test]
async fn native6_late_no_active_profile_data_holds_staged_activation() {
    let fixture = Fixture::native(false, true);
    let staged = fixture
        .install_mode(
            true,
            false,
            std::sync::Arc::new(crate::operation::NoLifecycleFaults),
        )
        .await
        .unwrap();
    let canonical = fixture
        .service
        .library()
        .user_dir(NATIVE_PORT)
        .join("profile/settings.ini");
    fs::create_dir_all(canonical.parent().unwrap()).unwrap();
    fs::write(&canonical, b"preserved unknown profile").unwrap();
    assert!(fixture.service.activate_staged(NATIVE_PORT).is_err());
    let status = fixture.service.status(NATIVE_PORT).unwrap();
    assert!(status.active.is_none());
    assert_eq!(status.staged.unwrap().id, staged.id);
    assert_eq!(fs::read(canonical).unwrap(), b"preserved unknown profile");
}

#[tokio::test]
async fn native6_authenticated_active_import_and_backup_restore_preserve_source_and_profile() {
    let mut fixture = Fixture::native(false, true);
    let catalog =
        crate::test_fixture::admitted_indexed_catalog(fixture.service.catalog(), NATIVE_PORT);
    crate::definition_candidate::selection::trust_catalog_selection_for_test(
        fixture.service.library(),
        &catalog,
        NATIVE_PORT,
    );
    fixture.service.replace_catalog_for_test(catalog);
    // Reuse the established future-definition import fixture authority. The
    // owned package starts unprepared; public preparation seals its real inputs.
    let root = fixture
        .service
        .library()
        .versions_dir()
        .join(NATIVE_PORT)
        .join("owned-indexed");
    let host = Platform::current().unwrap();
    let executable = root.join(
        &fixture
            .service
            .catalog()
            .port(NATIVE_PORT)
            .unwrap()
            .executable_hints[&host][0],
    );
    fs::create_dir_all(executable.parent().unwrap()).unwrap();
    fs::copy(&fixture.probe, &executable).unwrap();
    let artifact = crate::ArtifactIdentity {
        asset_name: "owned-indexed.zip".into(),
        sha256: crate::signed_catalog::digest(&fs::read(&fixture.probe).unwrap()),
        size: fs::metadata(&fixture.probe).unwrap().len(),
    };
    let qualification =
        InstallQualification::from_catalog(fixture.service.catalog(), NATIVE_PORT, host).unwrap();
    let (manifest_sha256, selected_executable, runtime) =
        Installer::new(fixture.service.library().clone())
            .unwrap()
            .create_manifest(
                "owned-indexed",
                NATIVE_PORT,
                "owned-indexed",
                &artifact,
                &qualification,
                &root,
            )
            .unwrap();
    fixture
        .service
        .library()
        .register_install(
            &InstallRecord {
                id: "owned-indexed".into(),
                port_id: NATIVE_PORT.into(),
                version: "owned-indexed".into(),
                path: root,
                channel: ReleaseChannel::Stable,
                installed_at: Library::now(),
                verified: true,
                staged: false,
                artifact,
                runtime,
                manifest_sha256,
                selected_executable,
            },
            true,
        )
        .unwrap();
    let installed = crate::test_fixture::phase("native originals: admitted preparation", || {
        fixture.run_preparation().unwrap()
    });
    let config = installed.path.join("publisher/profile/settings.ini");
    fs::create_dir_all(config.parent().unwrap()).unwrap();
    fs::write(&config, b"owned native profile").unwrap();
    let backup = crate::test_fixture::phase("native originals: backup", || {
        fixture.service.create_backup(NATIVE_PORT).unwrap()
    });
    let export = fixture._temporary.path().join("metadata.json");
    fixture.service.write_library_metadata(&export).unwrap();
    let destination = fixture._temporary.path().join("imported-library");
    let plan = crate::test_fixture::phase("native originals: import plan", || {
        PortcoveService::plan_library_import(
            &export,
            fixture.service.library().root(),
            &destination,
        )
        .unwrap()
    });
    crate::test_fixture::phase("native originals: authenticated import", || {
        PortcoveService::import_library(
            &export,
            fixture.service.library().root(),
            &destination,
            &plan.plan_sha256,
        )
        .unwrap()
    });
    let mut imported = PortcoveService::new(Library::open(&destination).unwrap()).unwrap();
    imported.replace_catalog_for_test(fixture.service.catalog().clone());
    let active = imported.status(NATIVE_PORT).unwrap().active.unwrap();
    require_fresh_canonical_data(
        imported.catalog().port(NATIVE_PORT).unwrap(),
        imported.library(),
    )
    .unwrap();
    assert!(imported.verify(NATIVE_PORT).unwrap().valid);
    assert!(imported.prepare_launch(NATIVE_PORT, None).is_ok());
    let imported_config = active.path.join("publisher/profile/settings.ini");
    fs::write(&imported_config, b"later profile choice").unwrap();
    imported.create_backup(NATIVE_PORT).unwrap();
    let preview = imported
        .preview_backup_action(NATIVE_PORT, &backup.id, crate::BackupAction::Restore)
        .unwrap();
    let consent = imported
        .authorize_backup_action(
            NATIVE_PORT,
            &backup.id,
            crate::BackupAction::Restore,
            &preview.preview_sha256,
        )
        .unwrap();
    crate::test_fixture::phase("native originals: retained backup restore", || {
        imported
            .restore_backup(NATIVE_PORT, &backup.id, &consent.token)
            .unwrap()
    });
    assert_eq!(fs::read(imported_config).unwrap(), b"owned native profile");
    crate::source_inspection::verify_registered(imported.catalog(), &fixture.source).unwrap();
}

struct NativeFixtureProvider(std::sync::Mutex<ResolvedRelease>);
#[async_trait::async_trait]
impl crate::ReleaseProvider for NativeFixtureProvider {
    async fn resolve(
        &self,
        _port: &PortDefinition,
        channel: ReleaseChannel,
        _platform: Platform,
    ) -> Result<ResolvedRelease> {
        let mut release = self.0.lock().unwrap().clone();
        release.channel = channel;
        Ok(release)
    }
}

fn native_fixture_release(
    fixture: &Fixture,
    version: &str,
) -> (ResolvedRelease, crate::test_http::HttpServer) {
    let host = Platform::current().unwrap();
    let executable = &fixture
        .service
        .catalog()
        .port(NATIVE_PORT)
        .unwrap()
        .executable_hints[&host][0];
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    writer
        .start_file(
            executable,
            zip::write::SimpleFileOptions::default().unix_permissions(0o755),
        )
        .unwrap();
    writer
        .write_all(&fs::read(&fixture.probe).unwrap())
        .unwrap();
    writer
        .start_file(
            "publisher/package-revision.txt",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
    writer.write_all(version.as_bytes()).unwrap();
    let bytes = writer.finish().unwrap().into_inner();
    let size = bytes.len() as u64;
    let sha256 = crate::signed_catalog::digest(&bytes);
    let mut response =
        format!("HTTP/1.1 200 OK\r\nContent-Length: {size}\r\nConnection: close\r\n\r\n")
            .into_bytes();
    response.extend(bytes);
    let (origin, _requests, server) = crate::test_http::serve_http_bytes(vec![response]);
    (
        ResolvedRelease {
            version: version.into(),
            channel: ReleaseChannel::Stable,
            published_at: None,
            asset: ReleaseAsset {
                name: "owned-native.zip".into(),
                url: format!("{origin}/owned-native.zip"),
                sha256,
                size,
            },
        },
        server,
    )
}

#[tokio::test]
async fn native6_same_source_stage_activate_and_rollback_preserve_current_profile_and_hold_remapping()
 {
    let mut fixture = Fixture::native(false, true);
    let catalog = fixture.service.catalog().clone();
    let (first_release, server) = native_fixture_release(&fixture, "v1");
    let provider = std::sync::Arc::new(NativeFixtureProvider(std::sync::Mutex::new(first_release)));
    fixture.service =
        PortcoveService::with_provider(fixture.service.library().clone(), provider.clone())
            .unwrap();
    fixture.service.replace_catalog_for_test(catalog.clone());
    let first = crate::test_fixture::async_phase(
        "native originals: provider install N",
        fixture
            .service
            .install(NATIVE_PORT, None, None, None, true, |_| {}),
    )
    .await
    .unwrap();
    server.join().unwrap();
    assert!(
        fixture
            .service
            .supervise_launch(
                NATIVE_PORT,
                None,
                &["--observe-launch".into()],
                LaunchStdio::Null,
                |_| {}
            )
            .unwrap()
            .successful
    );
    let first_config = first.path.join("publisher/profile/settings.ini");
    fs::create_dir_all(first_config.parent().unwrap()).unwrap();
    fs::write(&first_config, b"first profile choice").unwrap();
    let mut changed = catalog.authoritative_document();
    changed.ports[0].runtime_source_set[0].destination = "other-originals/base.bin".into();
    fixture.service.replace_catalog_for_test(
        Catalog::from_json(&serde_json::to_string(&changed).unwrap()).unwrap(),
    );
    assert!(
        fixture
            .service
            .update(NATIVE_PORT, None, None, false, |_| {})
            .await
            .is_err()
    );
    assert_eq!(
        fixture
            .service
            .status(NATIVE_PORT)
            .unwrap()
            .active
            .unwrap()
            .id,
        first.id
    );
    fixture.service.replace_catalog_for_test(catalog);
    let (second_release, server) = native_fixture_release(&fixture, "v2");
    *provider.0.lock().unwrap() = second_release;
    let staged = crate::test_fixture::async_phase(
        "native originals: provider stage N+1",
        fixture
            .service
            .update(NATIVE_PORT, None, None, false, |_| {}),
    )
    .await
    .unwrap();
    server.join().unwrap();
    assert_eq!(
        fixture
            .service
            .status(NATIVE_PORT)
            .unwrap()
            .active
            .unwrap()
            .id,
        first.id
    );
    let alternate = fixture._temporary.path().join("relinked-originals");
    fs::create_dir(&alternate).unwrap();
    for (name, bytes) in FILES {
        fs::write(alternate.join(name), bytes).unwrap();
    }
    fixture
        .service
        .register_source(&fixture.source.profile_id, &alternate)
        .unwrap();
    assert!(fixture.service.activate_staged(NATIVE_PORT).is_err());
    assert_eq!(
        fixture
            .service
            .status(NATIVE_PORT)
            .unwrap()
            .staged
            .unwrap()
            .id,
        staged.id
    );
    assert_eq!(fs::read(&first_config).unwrap(), b"first profile choice");
    fixture
        .service
        .register_source(&fixture.source.profile_id, &fixture.source.path)
        .unwrap();
    fs::write(&first_config, b"choice made after staging").unwrap();
    let second = crate::test_fixture::phase("native originals: activate N+1", || {
        fixture.service.activate_staged(NATIVE_PORT).unwrap()
    });
    assert_eq!(second.id, staged.id);
    let second_config = second.path.join("publisher/profile/settings.ini");
    assert_eq!(
        fs::read(&second_config).unwrap(),
        b"choice made after staging"
    );
    assert!(
        fixture
            .service
            .supervise_launch(
                NATIVE_PORT,
                None,
                &["--observe-launch".into()],
                LaunchStdio::Null,
                |_| {}
            )
            .unwrap()
            .successful
    );
    fs::write(&second_config, b"current choice at rollback").unwrap();
    fixture
        .service
        .register_source(&fixture.source.profile_id, &alternate)
        .unwrap();
    assert!(fixture.service.rollback(NATIVE_PORT).is_err());
    assert_eq!(
        fixture
            .service
            .status(NATIVE_PORT)
            .unwrap()
            .active
            .unwrap()
            .id,
        second.id
    );
    assert_eq!(
        fs::read(&second_config).unwrap(),
        b"current choice at rollback"
    );
    fixture
        .service
        .register_source(&fixture.source.profile_id, &fixture.source.path)
        .unwrap();
    let previous =
        crate::test_fixture::phase("native originals: rollback with current profile", || {
            fixture.service.rollback(NATIVE_PORT).unwrap()
        });
    assert_eq!(previous.id, first.id);
    assert_eq!(
        fs::read(first_config).unwrap(),
        b"current choice at rollback"
    );
    crate::source_inspection::verify_registered(fixture.service.catalog(), &fixture.source)
        .unwrap();
}

#[test]
fn native6_public_adoption_refuses_unadmitted_profile_without_external_mutation() {
    let mut fixture = Fixture::native(false, true);
    let mut document = fixture.service.catalog().authoritative_document();
    document.ports[0].windows_temp_directory = None;
    fixture.service.replace_catalog_for_test(
        Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap(),
    );
    let external = fixture._temporary.path().join("external-runtime");
    fs::create_dir_all(external.join("publisher/profile")).unwrap();
    let executable = &fixture
        .service
        .catalog()
        .port(NATIVE_PORT)
        .unwrap()
        .executable_hints[&Platform::current().unwrap()][0];
    fs::copy(&fixture.probe, external.join(executable)).unwrap();
    fs::write(
        external.join("publisher/profile/settings.ini"),
        b"unadmitted profile",
    )
    .unwrap();
    let before = crate::library_transfer::reviewed_tree(&external).unwrap();
    let preview = fixture
        .service
        .preview_adoption(&external, Some(NATIVE_PORT))
        .unwrap();
    let consent = fixture
        .service
        .authorize_adoption(&external, Some(NATIVE_PORT), &preview.plan_sha256)
        .unwrap();
    assert!(
        fixture
            .service
            .adopt(&external, Some(NATIVE_PORT), &consent.token)
            .is_err()
    );
    assert_eq!(
        crate::library_transfer::reviewed_tree(&external).unwrap(),
        before
    );
    assert!(fixture.service.library().all_installs().unwrap().is_empty());
    assert!(
        !fixture
            .service
            .library()
            .user_dir(NATIVE_PORT)
            .join("profile/settings.ini")
            .exists()
    );
}

#[test]
fn native6_cancelled_copies_never_publish_receipt_or_change_originals() {
    let fixture = Fixture::native(false, true);
    let catalog = fixture.service.catalog();
    let port = catalog.port(NATIVE_PORT).unwrap();
    let inputs = plan(catalog, port, &fixture.source, Platform::current().unwrap()).unwrap();
    for completed in 0..=FILES.len() {
        let temporary = tempfile::tempdir().unwrap();
        let payload = temporary.path().join("payload");
        let working = payload.join("publisher");
        fs::create_dir_all(&working).unwrap();
        let selected = payload.join(&port.executable_hints[&Platform::current().unwrap()][0]);
        fs::copy(&fixture.probe, &selected).unwrap();
        let program = crate::adapter::hash_file(&selected).unwrap();
        let cancelled = Cell::new(false);
        let result = materialize(
            catalog,
            port,
            &inputs,
            MaterializationRoot {
                payload: &payload,
                working: &working,
                replace_prepared: false,
            },
            &|| {
                if completed == 0
                    || working
                        .join("originals")
                        .join(FILES[completed - 1].0)
                        .is_file()
                {
                    cancelled.set(true);
                    return Err(PortcoveError::new(
                        crate::ErrorCode::Cancelled,
                        "owned native copy cancellation",
                    ));
                }
                Ok(())
            },
            &Cell::new(true),
        );
        assert_eq!(result.unwrap_err().code, crate::ErrorCode::Cancelled);
        assert!(cancelled.get());
        assert!(payload.is_dir());
        assert!(!payload.join(RECEIPT).exists());
        assert_eq!(crate::adapter::hash_file(&selected).unwrap(), program);
        crate::source_inspection::verify_registered(catalog, &fixture.source).unwrap();
    }
}

#[tokio::test]
async fn native6_unadmitted_raw_import_refuses_before_destination_mutation() {
    let fixture = Fixture::native(false, true);
    let installed = fixture.install(true).await;
    let export = fixture._temporary.path().join("unadmitted-metadata.json");
    fixture.service.write_library_metadata(&export).unwrap();
    let destination = fixture._temporary.path().join("refused-import");
    let error = PortcoveService::plan_library_import(
        &export,
        fixture.service.library().root(),
        &destination,
    )
    .unwrap_err();
    assert!(error.message.contains("no admitted authority"), "{error:?}");
    assert!(!destination.exists());
    assert!(installed.path.is_dir());
    assert!(fixture.service.verify(NATIVE_PORT).unwrap().valid);
    crate::source_inspection::verify_registered(fixture.service.catalog(), &fixture.source)
        .unwrap();
}
