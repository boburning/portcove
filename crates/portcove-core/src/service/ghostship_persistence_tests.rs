//! Inert persistence fixtures; no original game bytes or upstream code execute.
#![cfg(windows)]

use super::*;

fn fixture() -> (
    tempfile::TempDir,
    PortcoveService,
    InstallRecord,
    InstallRecord,
) {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let service = PortcoveService::new(library.clone()).unwrap();
    let qualification =
        InstallQualification::from_catalog(&service.catalog, "ghostship", Platform::WindowsX86_64)
            .unwrap();
    let root = library.versions_dir().join("ghostship").join("original");
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("Ghostship.exe"), b"inert executable").unwrap();
    fs::write(root.join("unrelated.bin"), b"preserved immutable").unwrap();
    let artifact = crate::ArtifactIdentity {
        asset_name: "Mary-Celeste-Alfa-Win64.zip".into(),
        sha256: "a49f4c791377fcc611264b8920f2c3254b3ab25747c2a59da9305c32f92a6d3f".into(),
        size: 21_561_620,
    };
    let installer = Installer::new(library.clone()).unwrap();
    let (manifest_sha256, selected_executable, runtime) = installer
        .create_manifest(
            "original",
            "ghostship",
            "2.0.0",
            &artifact,
            &qualification,
            &root,
        )
        .unwrap();
    let original = InstallRecord {
        id: "original".into(),
        port_id: "ghostship".into(),
        version: "2.0.0".into(),
        path: root,
        channel: ReleaseChannel::Stable,
        installed_at: 0,
        verified: true,
        staged: false,
        artifact,
        runtime,
        manifest_sha256,
        selected_executable,
    };
    library.register_install(&original, true).unwrap();
    let derived = library.versions_dir().join("ghostship").join("prepared");
    fs::create_dir_all(derived.join("prepared-game-data")).unwrap();
    fs::write(derived.join("Ghostship.exe"), b"inert executable").unwrap();
    fs::write(derived.join("unrelated.bin"), b"preserved immutable").unwrap();
    fs::write(
        derived.join(crate::preparation::RECEIPT_FILE),
        b"inert receipt",
    )
    .unwrap();
    fs::write(
        derived.join("prepared-game-data").join("sm64.o2r"),
        b"inert generated archive",
    )
    .unwrap();
    let prepared = installer
        .create_prepared_manifest(
            &original,
            "prepared",
            &qualification,
            crate::PreparationMode::Ghostship200Legacy,
            &derived,
        )
        .unwrap();
    library.register_install(&prepared, true).unwrap();
    (temporary, service, original, prepared)
}

#[test]
fn ghostship_derivative_preserves_the_exact_retained_envelope_not_only_port_facts() {
    let (_temporary, service, _original, prepared) = fixture();
    let installer = Installer::new(service.library.clone()).unwrap();
    let root = service
        .library
        .versions_dir()
        .join("ghostship/second-prepared");
    copy_tree(&prepared.path, &root).unwrap();
    let qualification = service
        .installed_mutability_qualification(&prepared)
        .unwrap();
    let mut derivative = installer
        .create_prepared_manifest(
            &prepared,
            "second-prepared",
            &qualification,
            crate::PreparationMode::Ghostship200Legacy,
            &root,
        )
        .unwrap();
    installer
        .require_same_retained_contract(&prepared, &derivative)
        .unwrap();
    let manifest = root.join(".portcove-manifest.json");
    let mut value: serde_json::Value =
        serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap();
    let catalog: serde_json::Value =
        serde_json::from_str(value["retained_contract"]["catalog_json"].as_str().unwrap()).unwrap();
    value["retained_contract"]["catalog_json"] =
        serde_json::Value::String(serde_json::to_string_pretty(&catalog).unwrap());
    let bytes = serde_json::to_vec(&value).unwrap();
    fs::write(&manifest, &bytes).unwrap();
    derivative.manifest_sha256 = crate::signed_catalog::digest(&bytes);
    assert_eq!(
        serde_json::to_value(
            installer
                .retained_catalog(&prepared)
                .unwrap()
                .unwrap()
                .authoritative_document()
        )
        .unwrap(),
        serde_json::to_value(
            installer
                .retained_catalog(&derivative)
                .unwrap()
                .unwrap()
                .authoritative_document()
        )
        .unwrap()
    );
    assert!(
        installer
            .require_same_retained_contract(&prepared, &derivative)
            .is_err()
    );
}

#[test]
fn ghostship_legacy_persistence_restores_collects_and_synchronizes_cwd() {
    let (_temporary, service, original, prepared) = fixture();
    let port = service.catalog.port("ghostship").unwrap();
    let user = service.library.user_dir("ghostship");
    fs::create_dir_all(user.join("saves")).unwrap();
    fs::write(user.join("sm64.o2r"), b"inert generated archive").unwrap();
    fs::write(user.join("ghostship.cfg.json"), b"before").unwrap();
    fs::write(user.join("saves").join("slot"), b"inert save fixture").unwrap();
    service.restore_user_data_to(port, &prepared.path).unwrap();
    assert_eq!(
        fs::read(prepared.path.join("sm64.o2r")).unwrap(),
        b"inert generated archive"
    );
    assert_eq!(
        fs::read(prepared.path.join("ghostship.cfg.json")).unwrap(),
        b"before"
    );
    fs::write(prepared.path.join("ghostship.cfg.json"), b"after").unwrap();
    fs::remove_file(prepared.path.join("saves").join("slot")).unwrap();
    service
        .collect_user_data_from(port, &prepared.path)
        .unwrap();
    assert_eq!(fs::read(user.join("ghostship.cfg.json")).unwrap(), b"after");
    assert!(!user.join("saves").join("slot").exists());
    fs::write(user.join("ghostship.cfg.json"), b"restored snapshot").unwrap();
    service.synchronize_restored_user_data("ghostship").unwrap();
    assert_eq!(
        fs::read(prepared.path.join("ghostship.cfg.json")).unwrap(),
        b"restored snapshot"
    );
    assert!(!original.path.join("ghostship.cfg.json").exists());
    for record in [&original, &prepared] {
        assert_eq!(
            fs::read(record.path.join("unrelated.bin")).unwrap(),
            b"preserved immutable"
        );
    }
}

#[test]
fn ghostship_legacy_backup_assessment_matches_collection_without_a_source() {
    let (_temporary, mut service, _original, prepared) = fixture();
    // A changed current definition must not reinterpret retained persistence.
    let mut document = service.catalog.authoritative_document();
    let changed = document
        .ports
        .iter_mut()
        .find(|port| port.id == "ghostship")
        .unwrap();
    changed.launch_arguments.push("--future-contract".into());
    service.catalog = Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap();
    assert!(
        service
            .library
            .source("ghostship-source")
            .unwrap()
            .is_none()
    );
    fs::write(prepared.path.join(LAUNCH_MARKER), b"1").unwrap();
    fs::write(prepared.path.join("ghostship.cfg.json"), b"runtime only").unwrap();
    let user = service.library.user_dir("ghostship");
    let assessment = service.list_backups("ghostship").unwrap().create_assessment;
    assert_eq!(assessment.availability, PortActionAvailability::Allowed);
    assert!(!user.join("ghostship.cfg.json").exists());
    let backup = service.create_backup("ghostship").unwrap();
    assert_eq!(
        fs::read(backup.path.join("data").join("ghostship.cfg.json")).unwrap(),
        b"runtime only"
    );
    assert_eq!(
        fs::read(user.join("ghostship.cfg.json")).unwrap(),
        b"runtime only"
    );
}

#[test]
fn ghostship_legacy_persistence_refuses_malformed_interpretation_without_copying() {
    let (_temporary, service, _original, mut prepared) = fixture();
    let path = prepared.path.join(".portcove-manifest.json");
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    manifest["retained_contract"]["original_format"] = serde_json::json!(4);
    let bytes = serde_json::to_vec(&manifest).unwrap();
    fs::write(&path, &bytes).unwrap();
    prepared.manifest_sha256 = hex::encode(Sha256::digest(&bytes));
    service.library.register_install(&prepared, true).unwrap();
    let user = service.library.user_dir("ghostship");
    fs::create_dir_all(&user).unwrap();
    fs::write(user.join("ghostship.cfg.json"), b"preserve canonical").unwrap();
    fs::write(
        prepared.path.join("ghostship.cfg.json"),
        b"preserve runtime",
    )
    .unwrap();
    let port = service.catalog.port("ghostship").unwrap();
    assert!(service.restore_user_data_to(port, &prepared.path).is_err());
    assert!(
        service
            .collect_user_data_from(port, &prepared.path)
            .is_err()
    );
    assert_eq!(
        fs::read(user.join("ghostship.cfg.json")).unwrap(),
        b"preserve canonical"
    );
    assert_eq!(
        fs::read(prepared.path.join("ghostship.cfg.json")).unwrap(),
        b"preserve runtime"
    );
}

#[test]
fn ghostship_unprepared_and_unregistered_persistence_keep_the_existing_contract() {
    let (_temporary, service, original, _prepared) = fixture();
    assert!(
        service
            .persistence_contract_for_install(&original)
            .unwrap()
            .writes_directly
    );
    let unregistered = service
        .library
        .versions_dir()
        .join("ghostship")
        .join("unpublished");
    fs::create_dir_all(&unregistered).unwrap();
    let port = service.catalog.port("ghostship").unwrap();
    assert!(
        service
            .persistence_contract(port, &unregistered)
            .unwrap()
            .writes_directly
    );
}

#[test]
fn ghostship_staged_preparation_requires_exact_ownership_before_absent_archive_shortcut() {
    use crate::operation::{LifecycleOperation, LifecycleOperationKind, LifecyclePhase};
    use crate::{
        PreparationInputs, PreparationMode, PreparationOptions, PreparationPlan, PreparationTool,
    };
    let (_temporary, service, _original, prepared) = fixture();
    let id = Uuid::new_v4().to_string();
    let staging = service.library.staging_dir().join(&id);
    let payload = staging.join("payload");
    copy_tree(&prepared.path, &payload).unwrap();
    let qualification =
        InstallQualification::from_catalog(&service.catalog, "ghostship", Platform::WindowsX86_64)
            .unwrap();
    let target = Installer::new(service.library.clone())
        .unwrap()
        .create_prepared_manifest(
            &prepared,
            &id,
            &qualification,
            PreparationMode::Ghostship200Legacy,
            &payload,
        )
        .unwrap();
    let source_path = staging.join("inert-original.z64");
    fs::write(
        &source_path,
        b"\x80\x37\x12\x40inert unsupported original\0\0",
    )
    .unwrap();
    let (sha256, size) = crate::adapter::hash_file(&source_path).unwrap();
    let source = SourceRecord {
        profile_id: "ghostship-source".into(),
        path: source_path.clone(),
        sha256: sha256.clone(),
        size,
        storage_sha256: sha256,
        storage_size: size,
        updated_at: 0,
        observed_identity: None,
    };
    let plan = PreparationPlan {
        format_version: 2,
        port_id: "ghostship".into(),
        inputs: PreparationInputs {
            install: prepared.clone(),
            definition_sha256: "0".repeat(64),
            source,
            source_inspection: service
                .inspect_source_report("ghostship-source", &source_path)
                .unwrap(),
            setup_tool: Some(PreparationTool {
                path: prepared.path.join("Ghostship.exe"),
                sha256: "0".repeat(64),
                size: 16,
            }),
            conversion_tool: None,
            host: Platform::WindowsX86_64,
            options: PreparationOptions {
                target: Platform::WindowsX86_64,
                mode: PreparationMode::Ghostship200Legacy,
            },
        },
        copy: crate::library_transfer::reviewed_tree(&prepared.path).unwrap(),
        plan_sha256: "0".repeat(64),
    };
    let mut operation = LifecycleOperation::new(&id, LifecycleOperationKind::Prepare, "ghostship");
    operation.phase = LifecyclePhase::Prepared;
    operation.activate = true;
    operation.paths.staging = Some(staging.clone());
    let mut published = target.clone();
    published.path = service.library.versions_dir().join("ghostship").join(&id);
    operation.paths.final_path = Some(published.path.clone());
    operation.install = Some(published);
    operation.preparation = Some(plan);
    operation.preparation_process_quiesced = Some(true);
    let canonical = service.library.user_dir("ghostship").join("sm64.o2r");
    assert!(!canonical.exists());
    // Exact ownership reaches content validation, never an absent-O2R success.
    assert!(
        service
            .require_ghostship_staged_preparation_compatibility(&operation, &target, None)
            .unwrap_err()
            .message
            .contains("exact original is not registered")
    );
    let before = crate::library_transfer::reviewed_tree(&staging).unwrap();
    for field in 0..11 {
        let mut changed = operation.clone();
        let mut changed_target = target.clone();
        match field {
            0 => changed.kind = LifecycleOperationKind::Install,
            1 => changed.phase = LifecyclePhase::PayloadPublished,
            2 => changed.preparation_process_quiesced = Some(false),
            3 => changed.port_id = "other".into(),
            4 => changed.id = Uuid::new_v4().to_string(),
            5 => changed.paths.final_path = Some(staging.join("wrong-final")),
            6 => changed_target.path = staging.join("other-payload"),
            7 => changed.activate = false,
            8 => changed.original_paths.push(source_path.clone()),
            9 => {
                changed.preparation.as_mut().unwrap().inputs.options.mode = PreparationMode::Default
            }
            10 => changed.preparation.as_mut().unwrap().inputs.install.port_id = "other".into(),
            _ => unreachable!(),
        }
        assert!(
            service
                .require_ghostship_staged_preparation_compatibility(&changed, &changed_target, None)
                .unwrap_err()
                .message
                .contains("invalid staged legacy preparation binding"),
            "field {field}"
        );
        assert_eq!(
            crate::library_transfer::reviewed_tree(&staging).unwrap(),
            before
        );
        assert!(!canonical.exists());
    }
    let mut mismatched = operation.clone();
    let mut mismatched_target = target.clone();
    mismatched_target.manifest_sha256 = "0".repeat(64);
    mismatched.install.as_mut().unwrap().manifest_sha256 =
        mismatched_target.manifest_sha256.clone();
    assert!(
        service
            .require_ghostship_staged_preparation_compatibility(
                &mismatched,
                &mismatched_target,
                None
            )
            .is_err()
    );
    assert_eq!(
        crate::library_transfer::reviewed_tree(&staging).unwrap(),
        before
    );
}

#[test]
fn ghostship_status_observes_original_metadata_but_operation_verifies_bytes() {
    let (temporary, service, _original, prepared) = fixture();
    let path = temporary.path().join("original.z64");
    fs::write(&path, b"original bytes").unwrap();
    let (sha256, size) = crate::adapter::hash_file(&path).unwrap();
    service
        .library
        .register_source(&SourceRecord {
            profile_id: "ghostship-source".into(),
            path: path.clone(),
            sha256: sha256.clone(),
            size,
            storage_sha256: sha256,
            storage_size: size,
            updated_at: 0,
            observed_identity: None,
        })
        .unwrap();
    fs::write(&path, b"tampered bytes").unwrap();
    let user = service.library.user_dir("ghostship");
    fs::create_dir_all(&user).unwrap();
    fs::write(user.join("sm64.o2r"), b"inert generated archive").unwrap();

    // This inert fixture's receipt is deliberately invalid; observation reaches
    // that boundary, while an operation must refuse the changed original first.
    let observed = service
        .inspect_ghostship_install_data_compatibility(&prepared, None)
        .unwrap_err();
    let verified = service
        .require_ghostship_install_data_compatibility(&prepared, None)
        .unwrap_err();
    let source = service.library.source("ghostship-source").unwrap().unwrap();
    let expected =
        crate::source_inspection::verify_registered(&service.catalog, &source).unwrap_err();
    assert_eq!(verified.message, expected.message);
    assert_ne!(observed.message, expected.message);
    assert_eq!(
        service
            .status("ghostship")
            .unwrap()
            .readiness
            .unwrap()
            .source,
        Some(SourceHealth::NotChecked)
    );
}
