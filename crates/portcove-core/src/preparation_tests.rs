
#[path = "preparation_execution_tests.rs"]
mod execution_tests;
use super::*;
use crate::{ArtifactIdentity, Catalog, ErrorCode, Library, ReleaseChannel};
use std::fs;

const PORT: &str = "opengoal-jak1";

struct Fixture {
    _temporary: tempfile::TempDir,
    service: PortcoveService,
    install: InstallRecord,
    source: PathBuf,
    setup: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temporary = tempfile::tempdir().unwrap();
        let library = Library::open(temporary.path().join("library")).unwrap();
        let service = PortcoveService::new(library.clone()).unwrap();
        let port = service.catalog().port(PORT).unwrap();
        let platform = Platform::current().unwrap();
        let artifact = ArtifactIdentity {
            asset_name: "owned-fixture.zip".into(),
            sha256: crate::signed_catalog::digest(b"owned-fixture-artifact"),
            size: 22,
        };
        let root = library.versions_dir().join(PORT).join(&artifact.sha256);
        fs::create_dir_all(&root).unwrap();
        let setup = root.join(&port.setup_executable_hints[&platform][0]);
        for relative in [
            &port.executable_hints[&platform][0],
            &port.setup_executable_hints[&platform][0],
        ] {
            let path = root.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            // Intentionally not executable program bytes: planning must never start them.
            fs::write(&path, b"owned inert fixture").unwrap();
            crate::permissions::normalize_archive_entry(&path, false, true).unwrap();
        }
        let qualification = InstallQualification::from_port(port, platform).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let (manifest_sha256, selected_executable, runtime) = Installer::new(library.clone())
            .unwrap()
            .create_manifest(&id, PORT, "fixture", &artifact, &qualification, &root)
            .unwrap();
        let install = InstallRecord {
            id,
            port_id: PORT.into(),
            version: "fixture".into(),
            path: root,
            channel: ReleaseChannel::Stable,
            installed_at: Library::now(),
            verified: true,
            staged: false,
            artifact,
            manifest_sha256,
            selected_executable,
            runtime,
        };
        library.register_install(&install, true).unwrap();
        let source = temporary.path().join("owned.iso");
        fs::write(&source, b"owned source awaiting the upstream validator").unwrap();
        let (sha256, size) = crate::adapter::hash_file(&source).unwrap();
        library
            .register_source(&SourceRecord {
                profile_id: port.source_profile.clone().unwrap(),
                path: source.clone(),
                sha256: sha256.clone(),
                size,
                storage_sha256: sha256,
                storage_size: size,
                updated_at: Library::now(),
                observed_identity: None,
            })
            .unwrap();
        Self {
            _temporary: temporary,
            service,
            install,
            source,
            setup,
        }
    }

    fn options(&self) -> PreparationOptions {
        PreparationOptions {
            target: Platform::current().unwrap(),
            mode: PreparationMode::Default,
        }
    }
}

#[test]
fn planning_is_stable_and_preserves_preliminary_source_and_unprepared_state() {
    let fixture = Fixture::new();
    // The real definitions use the executable's parent, not an explicit root override.
    assert!(
        !fixture
            .service
            .catalog()
            .port(PORT)
            .unwrap()
            .launch_from_install_root
    );
    let before = crate::library_transfer::reviewed_tree(&fixture.install.path).unwrap();
    let first = fixture
        .service
        .plan_preparation(PORT, fixture.options())
        .unwrap();
    let second = fixture
        .service
        .plan_preparation(PORT, fixture.options())
        .unwrap();
    assert_eq!(first.plan_sha256, second.plan_sha256);
    assert_eq!(first.inputs.install.id, fixture.install.id);
    assert_eq!(first.inputs.setup_tool.path, fixture.setup);
    assert!(first.inputs.conversion_tool.is_none());
    assert_eq!(first.copy, before);
    assert_eq!(
        crate::library_transfer::reviewed_tree(&fixture.install.path).unwrap(),
        before
    );
    assert!(
        fixture
            .service
            .status(PORT)
            .unwrap()
            .readiness
            .unwrap()
            .pending_setup
    );
    assert_eq!(
        first.inputs.source_inspection.state_code,
        "selected_needs_checking"
    );
}

#[test]
fn changed_source_or_setup_bytes_cannot_acquire_a_fresh_trust_identity() {
    let source = Fixture::new();
    fs::write(&source.source, b"changed source").unwrap();
    assert_eq!(
        source
            .service
            .plan_preparation(PORT, source.options())
            .unwrap_err()
            .code,
        ErrorCode::SourceInvalid
    );
    let setup = Fixture::new();
    fs::write(&setup.setup, b"changed setup").unwrap();
    assert_eq!(
        setup
            .service
            .plan_preparation(PORT, setup.options())
            .unwrap_err()
            .code,
        ErrorCode::Verification
    );
}

#[test]
fn definition_changes_invalidate_the_plan_and_options_fail_closed() {
    let mut fixture = Fixture::new();
    let before = fixture
        .service
        .plan_preparation(PORT, fixture.options())
        .unwrap();
    let mut document = fixture.service.catalog().document().clone();
    document
        .ports
        .iter_mut()
        .find(|port| port.id == PORT)
        .unwrap()
        .setup_arguments
        .push("--fixture-option".into());
    fixture.service.replace_catalog_for_test(
        Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap(),
    );
    let after = fixture
        .service
        .plan_preparation(PORT, fixture.options())
        .unwrap();
    assert_ne!(
        before.inputs.definition_sha256,
        after.inputs.definition_sha256
    );
    assert_ne!(before.plan_sha256, after.plan_sha256);
    let mut other = fixture.options();
    other.target = if other.target == Platform::WindowsX86_64 {
        Platform::LinuxX86_64
    } else {
        Platform::WindowsX86_64
    };
    assert_eq!(
        fixture
            .service
            .plan_preparation(PORT, other)
            .unwrap_err()
            .code,
        ErrorCode::Unsupported
    );
    let mut unknown = serde_json::to_value(fixture.options()).unwrap();
    unknown["renderer"] = serde_json::json!("unreviewed");
    assert!(serde_json::from_value::<PreparationOptions>(unknown).is_err());
}

#[test]
fn generated_outputs_cannot_claim_executables_sources_or_persistent_data() {
    let fixture = Fixture::new();
    let port = fixture.service.catalog().port(PORT).unwrap();
    validate_output_contract(port).unwrap();
    for outputs in [
        vec!["../outside".into()],
        vec![port.executable_hints[&Platform::current().unwrap()][0].clone()],
        vec![port.runtime_source_filename.clone().unwrap()],
        vec![port.persistent_paths[0].clone()],
        vec!["data".into()],
        vec!["data/out".into(), "data/out/jak1".into()],
        vec!["unrelated-output".into()],
        vec!["data/.PORTCOVE-hidden".into()],
    ] {
        let mut changed = port.clone();
        changed.setup_output_paths = outputs;
        assert!(validate_output_contract(&changed).is_err());
    }
    let mut nested = port.clone();
    nested.runtime_subdirectory = Some("nested".into());
    validate_output_contract(&nested).unwrap();
    let mut portable = port.clone();
    portable.portable_marker = true;
    portable.setup_output_paths.push("portable.txt".into());
    assert!(validate_output_contract(&portable).is_err());
    for reserved in [
        r"data\.PORTCOVE-hidden",
        "data/.portcove-hidden",
        r"data\source.PORTCOVE-source.json",
    ] {
        assert!(crate::path::is_portcove_metadata(std::path::Path::new(
            reserved
        )));
    }
    let mut legacy = port.clone();
    legacy.setup_output_paths.clear();
    // Old definitions remain readable; they cannot acquire the new preparation capability.
    validate_output_contract(&legacy).unwrap();
    let mut document = fixture.service.catalog().document().clone();
    *document
        .ports
        .iter_mut()
        .find(|candidate| candidate.id == PORT)
        .unwrap() = legacy;
    let mut service = fixture.service;
    service.replace_catalog_for_test(
        Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap(),
    );
    assert_eq!(
        service
            .plan_preparation(
                PORT,
                PreparationOptions {
                    target: Platform::current().unwrap(),
                    mode: PreparationMode::Default
                }
            )
            .unwrap_err()
            .code,
        ErrorCode::Unsupported
    );
}
