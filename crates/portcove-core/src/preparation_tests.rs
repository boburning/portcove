#[path = "preparation_execution_tests.rs"]
mod execution_tests;
use super::*;
use crate::test_fixture::phase as test_phase;
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
        Self::with_catalog(None)
    }

    fn with_catalog(catalog: Option<Catalog>) -> Self {
        let temporary = test_phase(
            "preparation fixture: temporary directory",
            tempfile::tempdir,
        )
        .unwrap();
        let library = test_phase("preparation fixture: library open", || {
            Library::open(temporary.path().join("library"))
        })
        .unwrap();
        let mut service = test_phase("preparation fixture: service open", || {
            PortcoveService::new(library.clone())
        })
        .unwrap();
        if let Some(catalog) = catalog {
            service.replace_catalog_for_test(catalog);
        }
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
        let qualification = test_phase("preparation fixture: retained qualification", || {
            preparation_qualification(service.catalog(), port, platform)
        })
        .unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let (manifest_sha256, selected_executable, runtime) =
            test_phase("preparation fixture: initial manifest", || {
                Installer::new(library.clone()).unwrap().create_manifest(
                    &id,
                    PORT,
                    "fixture",
                    &artifact,
                    &qualification,
                    &root,
                )
            })
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
        test_phase("preparation fixture: register install", || {
            library.register_install(&install, true)
        })
        .unwrap();
        let source = temporary.path().join("owned.iso");
        fs::write(&source, b"owned source awaiting the upstream validator").unwrap();
        let (sha256, size) = crate::adapter::hash_file(&source).unwrap();
        test_phase("preparation fixture: register source", || {
            library.register_source(&SourceRecord {
                profile_id: port.source_profile.clone().unwrap(),
                path: source.clone(),
                sha256: sha256.clone(),
                size,
                storage_sha256: sha256,
                storage_size: size,
                updated_at: Library::now(),
                observed_identity: None,
            })
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

// Only generic preparation publication/failure/recovery uses this graph. Planning,
// real layouts, retained-definition, legacy-launch and cleanup stay on embedded data.
fn generic_preparation_catalog(port: Option<&crate::PortDefinition>) -> Catalog {
    let platform = Platform::current().unwrap();
    let key = serde_json::to_value(platform)
        .unwrap()
        .as_str()
        .unwrap()
        .to_owned();
    let executable = if cfg!(windows) { "gk.exe" } else { "gk" };
    let setup = if cfg!(windows) {
        "extractor.exe"
    } else {
        "extractor"
    };
    let mut document = serde_json::json!({
        "schema_version": 2,
        "source_catalog": {
            "evidence": [{
                "id": "preparation-fixture-evidence", "role": "byte_identity",
                "authority": "Synthetic preparation fixture", "authority_ref": "fixture-1",
                "reviewed_at": "2026-10-03", "claim": "Owned synthetic setup input",
                "immutable_url": "https://example.invalid/fixtures/preparation-v1"
            }],
            "identities": [{
                "id": "preparation-fixture-disc", "label": "Owned fixture input", "kind": "optical-disc",
                "variants": [{ "id": "fixture-1", "title": "Owned fixture input",
                    "representations": [{ "id": "fixture-validator", "extensions": ["iso", "chd"],
                        "kind": "pinned-validator", "validator_contract_id": "preparation-fixture-validator",
                        "evidence_ids": ["preparation-fixture-evidence"] }],
                    "evidence_ids": ["preparation-fixture-evidence"] }]
            }],
            "contracts": [{
                "id": "preparation-fixture-game", "port_id": PORT, "role": "game",
                "profile_id": "preparation-fixture-disc", "admission_mode": "enforced",
                "validator_contract_id": "preparation-fixture-validator",
                "evidence_ids": ["preparation-fixture-evidence"], "authority_ref": "fixture-1",
                "reviewed_at": "2026-10-03", "immutable_review_url": "https://example.invalid/fixtures/preparation-v1"
            }],
            "validators": [{ "id": "preparation-fixture-validator", "tool_id": "owned-fixture-setup",
                "protocol_version": "fixture-1", "evidence_ids": ["preparation-fixture-evidence"] }]
        },
        "ports": [{
            "id": PORT, "name": "Synthetic upstream preparation", "summary": "Owned preparation lifecycle fixture",
            "project_url": "https://example.invalid/fixtures/preparation", "support_tier": "stable",
            "channels": ["stable"], "platforms": [platform], "adapter": "upstream-managed-setup",
            "release": { "repository": "fixture/preparation" },
            "source_profile": "preparation-fixture-disc", "runtime_source_filename": "source.iso",
            "runtime_source_materialization": "ps2-iso",
            "setup_executable_hints": {(key.clone()): [setup]},
            "setup_arguments": ["--game", "jak1", "--extract", "--decompile", "--compile", "--validate", "--disable-ansi"],
            "setup_marker": "data/out/jak1/iso/0COMMON.TXT",
            "launch_arguments": ["--game", "jak1", "--portable"],
            "executable_hints": {(key): [executable]},
            "runtime_mutable_paths": ["data/log", "data/imgui.ini"],
            "persistent_paths": ["OpenGOAL/jak1"],
            "setup_output_paths": ["data/iso_data", "data/decompiler_out", "data/out"],
            "presentation": { "installation_method": "upstream-setup", "source_requirements": [{
                "role": "game", "profile_id": "preparation-fixture-disc", "label": "Owned fixture input",
                "verification": "upstream-validator" }], "saves_and_settings": "portcove-managed" }
        }]
    });
    if let Some(port) = port {
        document["ports"][0] = serde_json::to_value(port).unwrap();
    }
    Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap()
}

fn preparation_qualification(
    catalog: &Catalog,
    port: &crate::PortDefinition,
    platform: Platform,
) -> Result<crate::InstallQualification> {
    if port.source_profile.as_deref() == Some("preparation-fixture-disc") {
        crate::InstallQualification::from_catalog(catalog, &port.id, platform)
    } else {
        crate::test_fixture::retained_qualification(port, platform)
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
fn installed_definition_survives_catalog_changes_and_options_fail_closed() {
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
    assert_eq!(
        before.inputs.definition_sha256,
        after.inputs.definition_sha256
    );
    assert_eq!(before.plan_sha256, after.plan_sha256);
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
fn preparation_retains_source_contract_and_review_after_catalog_changes() {
    let mut fixture = Fixture::new();
    let before = fixture
        .service
        .plan_preparation(PORT, fixture.options())
        .unwrap();
    let profile_id = before.inputs.source.profile_id.clone();
    let registered = serde_json::to_value(&before.inputs.source).unwrap();
    let source_bytes = fs::read(&fixture.source).unwrap();
    let mut document = fixture.service.catalog().authoritative_document();
    let profile = document
        .source_catalog
        .as_mut()
        .unwrap()
        .identities
        .iter_mut()
        .find(|profile| profile.id == profile_id)
        .unwrap();
    profile.label = "A later catalog description".into();
    document
        .ports
        .iter_mut()
        .find(|port| port.id == PORT)
        .unwrap()
        .presentation
        .as_mut()
        .unwrap()
        .source_requirements[0]
        .label = "A later catalog description".into();
    fixture.service.replace_catalog_for_test(
        Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap(),
    );
    assert_eq!(
        fixture
            .service
            .inspect_registered_source(&profile_id)
            .unwrap()
            .expected_identity
            .unwrap()
            .label,
        "A later catalog description"
    );
    let after = fixture
        .service
        .plan_preparation(PORT, fixture.options())
        .unwrap();
    assert_eq!(
        serde_json::to_value(&before).unwrap(),
        serde_json::to_value(&after).unwrap()
    );
    fixture
        .service
        .authorize_preparation(PORT, fixture.options(), &before.plan_sha256)
        .unwrap();
    assert_eq!(
        serde_json::to_value(fixture.service.library().source(&profile_id).unwrap()).unwrap(),
        registered
    );
    assert_eq!(fs::read(&fixture.source).unwrap(), source_bytes);
    fs::write(&fixture.source, b"changed after review").unwrap();
    assert_eq!(
        fixture
            .service
            .authorize_preparation(PORT, fixture.options(), &before.plan_sha256)
            .unwrap_err()
            .code,
        ErrorCode::SourceInvalid
    );
    assert_eq!(
        crate::library_transfer::reviewed_tree(&fixture.install.path).unwrap(),
        before.copy
    );
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
    nested.setup_output_paths = port
        .setup_output_paths
        .iter()
        .map(|path| format!("nested/{path}"))
        .collect();
    validate_output_contract(&nested).unwrap();
    let mut runtime_root_output = nested.clone();
    runtime_root_output.setup_output_paths = vec!["nested".into()];
    assert!(validate_output_contract(&runtime_root_output).is_err());
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
    // Removing a capability from the current catalog cannot remove the
    // already-admitted installation's retained setup contract.
    assert!(
        service
            .plan_preparation(
                PORT,
                PreparationOptions {
                    target: Platform::current().unwrap(),
                    mode: PreparationMode::Default
                }
            )
            .is_ok()
    );
}

#[test]
fn generic_preparation_graph_keeps_missing_reference_and_strict_source_rejection() {
    let catalog = generic_preparation_catalog(None);
    let mut missing = catalog.authoritative_document();
    missing.source_catalog.as_mut().unwrap().validators.clear();
    assert!(Catalog::from_json(&serde_json::to_string(&missing).unwrap()).is_err());
    let mut unknown = serde_json::to_value(catalog.authoritative_document()).unwrap();
    unknown["source_catalog"]["identities"][0]["unreviewed_source_fact"] = serde_json::json!(true);
    assert!(Catalog::from_json(&serde_json::to_string(&unknown).unwrap()).is_err());
    assert!(generic_preparation_catalog(None).port(PORT).is_ok());
}
