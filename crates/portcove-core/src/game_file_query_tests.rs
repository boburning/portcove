use super::*;
use crate::{Catalog, Library, PortcoveService, SourceRepresentationKind};
use sha2::{Digest, Sha256};

fn complete_set() -> (
    tempfile::TempDir,
    Catalog,
    RegisteredSourceObservation,
    String,
) {
    let temporary = tempfile::tempdir().unwrap();
    let directory = temporary.path().join("set");
    std::fs::create_dir(&directory).unwrap();
    let mut document = Catalog::embedded().unwrap().authoritative_document();
    let source_catalog = document.source_catalog.as_mut().unwrap();
    let profile = source_catalog
        .identities
        .iter_mut()
        .find(|profile| profile.id == "g-diffuser-source-set")
        .unwrap();
    let variant = profile
        .variants
        .iter_mut()
        .find(|variant| !variant.legacy_projection_only)
        .unwrap();
    let SourceRepresentationKind::FileSet { members } = &mut variant.representations[0].kind else {
        panic!("existing set fixture");
    };
    for (index, member) in members.iter_mut().enumerate() {
        let bytes = format!("inert route member {index}");
        std::fs::write(directory.join(&member.filenames[0]), bytes.as_bytes()).unwrap();
        member.identities = vec![crate::DigestIdentity {
            scope: crate::DigestScope::FileSetMember,
            sha1: None,
            sha256: Some(hex::encode(Sha256::digest(bytes.as_bytes()))),
            crc32: None,
        }];
    }
    let contract = source_catalog
        .contracts
        .iter_mut()
        .find(|contract| contract.profile_id == profile.id && contract.role == PortSourceRole::Game)
        .unwrap();
    contract.admission_mode = CatalogAdmissionMode::Enforced;
    contract.supported_variant_ids = vec![variant.id.clone()];
    contract.applicability = vec![crate::SourceContractApplicability {
        upstream_ref: "fixture-release".into(),
        artifact_sha256: Some("a".repeat(64)),
    }];
    let port_id = contract.port_id.clone();
    let catalog = Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap();
    let inspection =
        crate::source_inspection::inspect(&catalog, "g-diffuser-source-set", &directory).unwrap();
    let record = inspection.record.clone().unwrap();
    let report =
        crate::source_report::available_report(&catalog, Some(record), inspection).unwrap();
    (
        temporary,
        catalog,
        RegisteredSourceObservation::Inspected {
            report: Box::new(report),
        },
        port_id,
    )
}

fn context<'a>(catalog: &'a Catalog, port_id: &'a str) -> GameFileRouteContext<'a> {
    GameFileRouteContext {
        catalog,
        port_id,
        platform: Platform::WindowsX86_64,
        channel: ReleaseChannel::Stable,
        route: GameFileRouteKind::ManagedInstall,
        offered: true,
        context_complete: true,
        requirements: GameInputRequirements::Profile("g-diffuser-source-set"),
        release: Some((
            "fixture-release",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )),
    }
}

#[test]
fn complete_compatible_set_is_bound_to_variant_release_and_registered_instance() {
    let (_temporary, catalog, observation, port_id) = complete_set();
    let result = project(&context(&catalog, &port_id), Some(&observation), true).unwrap();
    assert_eq!(result.state, GameFileQueryState::FilesAvailable);
    assert_eq!(
        result.reason,
        GameFileQueryReason::CompleteCompatibleObservation
    );
    assert!(result.identity.is_some());
    assert!(result.contract_id.is_some());
    assert_eq!(result.source_instance_sha256.unwrap().len(), 64);
    for release in [
        None,
        Some((
            "other-release",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )),
        Some((
            "fixture-release",
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        )),
    ] {
        let mut selected = context(&catalog, &port_id);
        selected.release = release;
        assert_eq!(
            project(&selected, Some(&observation), true).unwrap().reason,
            GameFileQueryReason::ReleaseNotBound
        );
    }
}

#[test]
fn uncertain_health_identity_and_storage_never_establish_available_or_missing_files() {
    let (_temporary, catalog, original, port_id) = complete_set();
    for health in [
        SourceHealth::Missing,
        SourceHealth::Unreadable,
        SourceHealth::Changed,
        SourceHealth::NotChecked,
        SourceHealth::NotBaselined,
    ] {
        let mut observation = original.clone();
        let RegisteredSourceObservation::Inspected { report } = &mut observation else {
            unreachable!()
        };
        report.health = health;
        let result = project(&context(&catalog, &port_id), Some(&observation), true).unwrap();
        assert_eq!(result.state, GameFileQueryState::NeedsChecking);
        if health == SourceHealth::Missing {
            assert_eq!(
                result.reason,
                GameFileQueryReason::StorageAbsenceUnconfirmed
            );
        }
    }
    let mut observation = original.clone();
    let RegisteredSourceObservation::Inspected { report } = &mut observation else {
        unreachable!()
    };
    let assessment = &mut report.inspection.as_mut().unwrap().assessment;
    assessment.classification = SourceClassification::Ambiguous { candidates: vec![] };
    assessment.admission = SourceAdmission::Rejected {
        reason: crate::SourceRejectionReason::AmbiguousIdentity,
    };
    assert_eq!(
        project(&context(&catalog, &port_id), Some(&observation), true)
            .unwrap()
            .reason,
        GameFileQueryReason::IdentityNotAdmitted
    );
    assert_eq!(
        project(&context(&catalog, &port_id), Some(&original), false)
            .unwrap()
            .reason,
        GameFileQueryReason::ObservationStale
    );
    assert_eq!(
        project(&context(&catalog, &port_id), None, true)
            .unwrap()
            .state,
        GameFileQueryState::UnavailableContext
    );
}

#[test]
fn unregistered_empty_unknown_and_unoffered_requirements_remain_distinct() {
    let (_temporary, catalog, observation, port_id) = complete_set();
    let unregistered = RegisteredSourceObservation::Unregistered {
        profile_id: "g-diffuser-source-set".into(),
    };
    let mut selected = context(&catalog, &port_id);
    let result = project(&selected, Some(&unregistered), true).unwrap();
    assert_eq!(result.state, GameFileQueryState::FilesMissing);
    assert_eq!(result.reason, GameFileQueryReason::NoConnectedRegistration);
    selected.requirements = GameInputRequirements::Empty;
    selected.route = GameFileRouteKind::ExternalRegistration;
    assert_eq!(
        project(&selected, None, true).unwrap().state,
        GameFileQueryState::NoFilesRequired
    );
    selected.requirements = GameInputRequirements::Unknown;
    assert_eq!(
        project(&selected, Some(&observation), true).unwrap().state,
        GameFileQueryState::NeedsChecking
    );
    selected.offered = false;
    selected.requirements = GameInputRequirements::Empty;
    assert_eq!(
        project(&selected, None, true).unwrap().reason,
        GameFileQueryReason::RouteNotOffered
    );
}

fn service_fixture() -> (
    tempfile::TempDir,
    PortcoveService,
    crate::RegisteredSourceInspectionBatch,
) {
    let temporary = tempfile::tempdir().unwrap();
    let service =
        PortcoveService::new(Library::open(temporary.path().join("library")).unwrap()).unwrap();
    let batch = service
        .inspect_registered_sources_bounded(
            &["ocarina-of-time".into()],
            &crate::RegisteredSourceInspectionLimits {
                max_file_bytes: 1024,
                max_hash_bytes: 1024,
                max_elapsed_ms: 30_000,
            },
            &crate::OperationCoordinator::new("query-fixture", None),
        )
        .unwrap();
    (temporary, service, batch)
}

#[test]
fn service_projects_real_missing_registration_without_planning_or_mutation() {
    let (_temporary, service, batch) = service_fixture();
    let port = service
        .catalog()
        .ports()
        .iter()
        .find(|port| {
            port.source_profile.as_deref() == Some("ocarina-of-time")
                && port.release.provider != crate::ReleaseSource::UserPrepared
        })
        .unwrap();
    let request = GameFileRouteRequest {
        port_id: port.id.clone(),
        platform: port.platforms[0],
        channel: port.channels[0],
        route: GameFileRouteKind::ManagedInstall,
    };
    let before = serde_json::to_vec(&service.library().activities(100).unwrap()).unwrap();
    let result = service
        .game_file_query_snapshot(&batch, &[request.clone()], 300)
        .unwrap();
    assert_eq!(result.routes[0].state, GameFileQueryState::FilesMissing);
    assert_eq!(
        result.routes[0].reason,
        GameFileQueryReason::NoConnectedRegistration
    );
    assert_eq!(
        before,
        serde_json::to_vec(&service.library().activities(100).unwrap()).unwrap()
    );
    assert!(service.library().sources().unwrap().is_empty());
    assert!(
        service
            .game_file_query_snapshot(&batch, &[request.clone(), request.clone()], 300)
            .is_err()
    );
    let mut stale = batch.clone();
    stale.observed_at = Library::now() - 301;
    assert_eq!(
        service
            .game_file_query_snapshot(&stale, &[request.clone()], 300)
            .unwrap()
            .routes[0]
            .reason,
        GameFileQueryReason::ObservationStale
    );
    let mut wrong = batch.clone();
    wrong.registration_sha256 = "0".repeat(64);
    assert!(
        service
            .game_file_query_snapshot(&wrong, &[request], 300)
            .is_err()
    );
}

#[test]
fn package_registration_does_not_imply_external_launch_has_no_game_inputs() {
    let (_temporary, service, batch) = service_fixture();
    let port = service
        .catalog()
        .ports()
        .iter()
        .find(|port| {
            port.release.provider == crate::ReleaseSource::UserPrepared
                && !port.release.user_prepared.is_empty()
        })
        .unwrap();
    let platform = *port.release.user_prepared.keys().next().unwrap();
    let mut request = GameFileRouteRequest {
        port_id: port.id.clone(),
        platform,
        channel: port.channels[0],
        route: GameFileRouteKind::ExternalRegistration,
    };
    let result = service
        .game_file_query_snapshot(&batch, &[request.clone()], 300)
        .unwrap();
    assert_eq!(result.routes[0].state, GameFileQueryState::NoFilesRequired);
    request.route = GameFileRouteKind::ExternalLaunch;
    let result = service
        .game_file_query_snapshot(&batch, &[request], 300)
        .unwrap();
    assert_eq!(result.routes[0].state, GameFileQueryState::NeedsChecking);
    assert_eq!(
        result.routes[0].reason,
        GameFileQueryReason::RouteNotOffered
    );
}

fn inert_install(service: &PortcoveService, port_id: &str, active: bool) -> crate::InstallRecord {
    let port = service.catalog().port(port_id).unwrap();
    let platform = port.platforms[0];
    let artifact = crate::ArtifactIdentity {
        asset_name: "inert-fixture.zip".into(),
        sha256: "a".repeat(64),
        size: 4,
    };
    let path = service
        .library()
        .versions_dir()
        .join(port_id)
        .join(&artifact.sha256);
    std::fs::create_dir_all(&path).unwrap();
    let executable = &port.executable_hints[&platform][0];
    let executable_path = path.join(executable);
    std::fs::create_dir_all(executable_path.parent().unwrap()).unwrap();
    std::fs::write(&executable_path, b"inert fixture; never executed").unwrap();
    let qualification = crate::test_fixture::retained_qualification(port, platform).unwrap();
    let (manifest_sha256, selected_executable, runtime) =
        crate::Installer::new(service.library().clone())
            .unwrap()
            .create_manifest(
                "query-install",
                port_id,
                "fixture-release",
                &artifact,
                &qualification,
                &path,
            )
            .unwrap();
    let install = crate::InstallRecord {
        id: "query-install".into(),
        port_id: port_id.into(),
        version: "fixture-release".into(),
        path,
        channel: port.channels[0],
        installed_at: Library::now(),
        verified: true,
        staged: !active,
        artifact,
        manifest_sha256,
        selected_executable,
        runtime,
    };
    service
        .library()
        .register_install(&install, active)
        .unwrap();
    install
}

#[test]
fn existing_external_registration_excludes_current_managed_install() {
    let (_temporary, service, batch) = service_fixture();
    let port = service.catalog().port("zelda64-recomp").unwrap();
    let record = crate::ExternalRuntimeRecord {
        id: "historical-external".into(),
        port_id: port.id.clone(),
        path: service.library().root().join("inert-external"),
        executable: "inert.exe".into(),
        version: "retained-external".into(),
        platform: port.platforms[0],
        archive_sha256: "a".repeat(64),
        immutable_tree_sha256: "b".repeat(64),
        registered_at: Library::now(),
        retained_definition: None,
    };
    // A retained external instance may survive a newer managed definition.
    service
        .library()
        .register_external_runtime(&record, service.catalog())
        .unwrap();
    let request = GameFileRouteRequest {
        port_id: port.id.clone(),
        platform: port.platforms[0],
        channel: port.channels[0],
        route: GameFileRouteKind::ManagedInstall,
    };
    let result = service
        .game_file_query_snapshot(&batch, &[request], 300)
        .unwrap();
    assert_eq!(
        result.routes[0].reason,
        GameFileQueryReason::RouteNotOffered
    );
    assert_eq!(
        crate::definition_eligibility::admission_route_exclusion(
            port,
            &service
                .library()
                .status(&port.id, port.channels[0])
                .unwrap(),
            port.platforms[0],
            crate::PortAction::Install
        ),
        Some(crate::PortActionReason::AlreadyRegistered)
    );
}

#[test]
fn existing_managed_install_excludes_external_registration() {
    let (_temporary, service, batch) = service_fixture();
    let port = service
        .catalog()
        .ports()
        .iter()
        .find(|port| {
            port.release.provider == crate::ReleaseSource::UserPrepared
                && !port.release.user_prepared.is_empty()
        })
        .unwrap();
    // An older managed instance is still a route exclusion even if today's
    // definition now offers only user-prepared registration.
    let install = crate::InstallRecord {
        id: "legacy-managed".into(),
        port_id: port.id.clone(),
        version: "retained".into(),
        path: service
            .library()
            .versions_dir()
            .join(&port.id)
            .join("retained"),
        channel: port.channels[0],
        installed_at: Library::now(),
        verified: false,
        staged: true,
        artifact: Default::default(),
        runtime: None,
        manifest_sha256: String::new(),
        selected_executable: "inert.exe".into(),
    };
    service.library().register_install(&install, false).unwrap();
    let request = GameFileRouteRequest {
        port_id: port.id.clone(),
        platform: *port.release.user_prepared.keys().next().unwrap(),
        channel: port.channels[0],
        route: GameFileRouteKind::ExternalRegistration,
    };
    let result = service
        .game_file_query_snapshot(&batch, &[request], 300)
        .unwrap();
    assert_eq!(
        result.routes[0].reason,
        GameFileQueryReason::RouteNotOffered
    );
    assert_ne!(result.routes[0].state, GameFileQueryState::NoFilesRequired);
}

#[test]
fn retained_launch_uses_verified_platform_and_marks_unreadable_context_unavailable() {
    let (_temporary, service, batch) = service_fixture();
    let port = service
        .catalog()
        .ports()
        .iter()
        .find(|port| {
            port.source_profile.as_deref() == Some("ocarina-of-time")
                && port.release.provider != crate::ReleaseSource::UserPrepared
        })
        .unwrap();
    let install = inert_install(&service, &port.id, true);
    crate::output_root::validate_install_path(service.library(), &port.id, &install.path).unwrap();
    let retained = crate::install::retained_query_context(&install).unwrap();
    assert!(retained.0.is_some());
    assert!(retained.1.is_some());
    let mut request = GameFileRouteRequest {
        port_id: port.id.clone(),
        platform: port.platforms[0],
        channel: port.channels[0],
        route: GameFileRouteKind::ManagedLaunch,
    };
    let result = service
        .game_file_query_snapshot(&batch, &[request.clone()], 300)
        .unwrap();
    assert_eq!(
        result.routes[0].reason,
        GameFileQueryReason::NoConnectedRegistration
    );
    assert!(result.routes[0].route_definition_sha256.is_some());
    assert!(result.routes[0].route_instance_sha256.is_some());
    request.platform = if request.platform == Platform::WindowsX86_64 {
        Platform::LinuxX86_64
    } else {
        Platform::WindowsX86_64
    };
    let result = service
        .game_file_query_snapshot(&batch, &[request.clone()], 300)
        .unwrap();
    assert_eq!(
        result.routes[0].reason,
        GameFileQueryReason::RouteNotOffered
    );
    std::fs::write(
        install.path.join(".portcove-manifest.json"),
        b"changed fixture",
    )
    .unwrap();
    let result = service
        .game_file_query_snapshot(&batch, &[request], 300)
        .unwrap();
    assert_eq!(
        result.routes[0].state,
        GameFileQueryState::UnavailableContext
    );
    assert!(result.routes[0].route_definition_sha256.is_none());
    assert!(result.routes[0].route_instance_sha256.is_some());
}

#[test]
fn route_identifier_budget_and_known_catalog_membership_are_checked_before_projection() {
    let (_temporary, service, batch) = service_fixture();
    for port_id in ["x".repeat(129), "unknown-port".into()] {
        let request = GameFileRouteRequest {
            port_id,
            platform: Platform::WindowsX86_64,
            channel: crate::ReleaseChannel::Stable,
            route: GameFileRouteKind::ManagedInstall,
        };
        assert!(
            service
                .game_file_query_snapshot(&batch, &[request], 300)
                .is_err()
        );
    }
}

#[test]
fn mismatched_profile_and_unsupported_variant_never_establish_compatibility() {
    let (_temporary, catalog, original, port_id) = complete_set();
    let mut mismatched = original.clone();
    let RegisteredSourceObservation::Inspected { report } = &mut mismatched else {
        panic!("fixture report");
    };
    report.expected_identity = None;
    assert_eq!(
        project(&context(&catalog, &port_id), Some(&mismatched), true)
            .unwrap()
            .reason,
        GameFileQueryReason::ProfileContextChanged
    );
    let mut unsupported = original;
    let RegisteredSourceObservation::Inspected { report } = &mut unsupported else {
        panic!("fixture report");
    };
    let SourceClassification::Recognized { identity } = &mut report
        .inspection
        .as_mut()
        .unwrap()
        .assessment
        .classification
    else {
        panic!("fixture identity");
    };
    identity.variant_id = "unsupported-fixture-variant".into();
    assert_eq!(
        project(&context(&catalog, &port_id), Some(&unsupported), true)
            .unwrap()
            .reason,
        GameFileQueryReason::VariantNotSupported
    );
}
