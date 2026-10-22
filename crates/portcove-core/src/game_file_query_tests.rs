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
        .game_file_query_snapshot(&batch, std::slice::from_ref(&request), 300)
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
            .game_file_query_snapshot(&stale, std::slice::from_ref(&request), 300)
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
fn route_bindings_preserve_the_released_owned_catalog_tuple_hash() {
    let (_temporary, service, _batch) = service_fixture();
    let mut request = managed_request(&service);
    inert_install(&service, &request.port_id, true);
    let current_document = service.catalog().authoritative_document();
    for route in [
        GameFileRouteKind::ManagedInstall,
        GameFileRouteKind::ManagedLaunch,
    ] {
        request.route = route;
        let selected = resolve_route(&service, &request).unwrap();
        // The original owned-document tuple at 6466c117 is the compatibility
        // oracle, independent of the operation-local document reuse.
        let original = crate::source_batch::fingerprint(&(
            &request,
            selected.catalog.authoritative_document(),
            selected.context_complete,
            selected.offered,
            selected.empty_requirements,
            selected.unknown_requirements,
            &selected.profile_id,
            &selected.release,
            &selected.instance_sha256,
        ))
        .unwrap();
        assert_eq!(
            selected.binding(&request, &current_document).unwrap(),
            original
        );
    }
}

#[test]
fn a_changed_current_catalog_invalidates_the_previously_accepted_batch() {
    let (_temporary, mut service, batch) = service_fixture();
    let request = managed_request(&service);
    service
        .game_file_query_snapshot(&batch, std::slice::from_ref(&request), 300)
        .unwrap();
    let mut document = service.catalog().authoritative_document();
    document
        .ports
        .iter_mut()
        .find(|port| port.id == request.port_id)
        .unwrap()
        .name
        .push('!');
    service.replace_catalog_for_test(
        Catalog::from_json(&serde_json::to_string(&document).unwrap()).unwrap(),
    );
    let error = service
        .game_file_query_snapshot(&batch, &[request], 300)
        .unwrap_err();
    assert_eq!(error.code, crate::ErrorCode::Conflict);
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
        user_selected: None,
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
        shared_preferences: None,
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
    let (_temporary, mut service, _batch) = service_fixture();
    let port = service
        .catalog()
        .ports()
        .iter()
        .find(|port| {
            port.source_profile.as_deref() == Some("ocarina-of-time")
                && port.release.provider != crate::ReleaseSource::UserPrepared
        })
        .unwrap()
        .clone();
    // Retain a distinct historical definition, then restore today's catalog
    // before inspection so the service and library agree on current authority.
    let current = service.catalog().clone();
    let mut historical = current.authoritative_document();
    historical
        .ports
        .iter_mut()
        .find(|definition| definition.id == port.id)
        .unwrap()
        .name
        .push_str(" (retained catalog)");
    service.replace_catalog_for_test(
        Catalog::from_json(&serde_json::to_string(&historical).unwrap()).unwrap(),
    );
    let install = inert_install(&service, &port.id, true);
    service.replace_catalog_for_test(current);
    crate::output_root::validate_install_path(service.library(), &port.id, &install.path).unwrap();
    let retained = crate::install::retained_query_context(&install).unwrap();
    assert!(retained.0.is_some());
    assert!(retained.1.is_some());
    let batch = service
        .inspect_registered_sources_bounded(
            &["ocarina-of-time".into()],
            &refresh_limits(),
            &crate::OperationCoordinator::new("retained-query-fixture", None),
        )
        .unwrap();
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
    let retained_hash =
        crate::source_batch::fingerprint(&retained.0.as_ref().unwrap().authoritative_document())
            .unwrap();
    let current_hash =
        crate::source_batch::fingerprint(&service.catalog().authoritative_document()).unwrap();
    assert_ne!(retained_hash, current_hash);
    assert_eq!(
        result.routes[0].route_definition_sha256,
        Some(retained_hash)
    );
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

fn refresh_limits() -> crate::RegisteredSourceInspectionLimits {
    crate::RegisteredSourceInspectionLimits {
        max_file_bytes: 1024,
        max_hash_bytes: 1024,
        max_elapsed_ms: 30_000,
    }
}

fn managed_request(service: &PortcoveService) -> GameFileRouteRequest {
    let port = service
        .catalog()
        .ports()
        .iter()
        .find(|port| {
            port.source_profile.as_deref() == Some("ocarina-of-time")
                && port.release.provider != crate::ReleaseSource::UserPrepared
        })
        .unwrap();
    GameFileRouteRequest {
        port_id: port.id.clone(),
        platform: port.platforms[0],
        channel: port.channels[0],
        route: GameFileRouteKind::ManagedInstall,
    }
}

fn register_inert_query_source(
    service: &PortcoveService,
    path: std::path::PathBuf,
) -> crate::SourceRecord {
    let bytes = b"\x80\x37\x12\x40inert registered-input fixture___";
    std::fs::write(&path, bytes).unwrap();
    let hash = hex::encode(Sha256::digest(bytes));
    let record = crate::SourceRecord {
        profile_id: "ocarina-of-time".into(),
        path,
        sha256: hash.clone(),
        size: bytes.len() as u64,
        storage_sha256: hash,
        storage_size: bytes.len() as u64,
        updated_at: 1,
        observed_identity: None,
    };
    service.library().register_source(&record).unwrap();
    record
}

#[test]
fn explicit_refresh_constructs_its_own_batch_and_does_not_mutate_source_or_activity() {
    let (temporary, service, _batch) = service_fixture();
    let record = register_inert_query_source(&service, temporary.path().join("input.z64"));
    let before = serde_json::to_vec(&service.library().sources().unwrap()).unwrap();
    let activities = serde_json::to_vec(&service.library().activities(100).unwrap()).unwrap();
    let snapshot = service
        .refresh_game_file_query(
            &[managed_request(&service)],
            &refresh_limits(),
            300,
            &crate::OperationCoordinator::new("query-refresh", None),
        )
        .unwrap();
    assert_eq!(
        snapshot.routes[0].reason,
        GameFileQueryReason::IdentityNotAdmitted
    );
    assert_eq!(
        before,
        serde_json::to_vec(&service.library().sources().unwrap()).unwrap()
    );
    assert_eq!(
        activities,
        serde_json::to_vec(&service.library().activities(100).unwrap()).unwrap()
    );
    assert_eq!(
        std::fs::read(record.path).unwrap(),
        b"\x80\x37\x12\x40inert registered-input fixture___"
    );
}

#[test]
fn empty_requirements_select_zero_source_profiles_and_zero_hashing() {
    let (temporary, service, _batch) = service_fixture();
    register_inert_query_source(&service, temporary.path().join("unrelated.z64"));
    let port = service
        .catalog()
        .ports()
        .iter()
        .find(|port| {
            port.release.provider == crate::ReleaseSource::UserPrepared
                && !port.release.user_prepared.is_empty()
        })
        .unwrap();
    let request = GameFileRouteRequest {
        port_id: port.id.clone(),
        platform: *port.release.user_prepared.keys().next().unwrap(),
        channel: port.channels[0],
        route: GameFileRouteKind::ExternalRegistration,
    };
    let mut limits = refresh_limits();
    limits.max_hash_bytes = 1;
    let snapshot = service
        .refresh_game_file_query(
            &[request],
            &limits,
            300,
            &crate::OperationCoordinator::new("empty-refresh", None),
        )
        .unwrap();
    assert_eq!(
        snapshot.routes[0].state,
        GameFileQueryState::NoFilesRequired
    );
    assert_eq!(
        snapshot.registration_sha256,
        crate::source_batch::fingerprint(&Vec::<crate::SourceRecord>::new()).unwrap()
    );
    assert_eq!(service.library().sources().unwrap().len(), 1);
    service
        .inspect_registered_sources_bounded_with_projection(
            &[],
            &limits,
            &crate::OperationCoordinator::new("empty-worker", None),
            |batch| {
                assert!(batch.profile_ids.is_empty());
                assert_eq!(batch.hash_bytes, 0);
                Ok(())
            },
            |_| Ok(()),
        )
        .unwrap();
    assert!(
        service
            .inspect_registered_sources_bounded(
                &[],
                &limits,
                &crate::OperationCoordinator::new("public-empty", None)
            )
            .is_err()
    );
}

#[test]
fn empty_internal_observations_never_assert_required_files_missing_or_available() {
    let (_temporary, service, _batch) = service_fixture();
    let request = managed_request(&service);
    let snapshot = service
        .inspect_registered_sources_bounded_with_projection(
            &[],
            &refresh_limits(),
            &crate::OperationCoordinator::new("absent-observation", None),
            |batch| service.game_file_query_snapshot(&batch, &[request], 300),
            |_| Ok(()),
        )
        .unwrap();
    assert_eq!(
        snapshot.routes[0].state,
        GameFileQueryState::UnavailableContext
    );
}

#[test]
fn late_channel_or_instance_drift_discards_the_private_refresh_result() {
    for change in ["channel", "instance"] {
        let (_temporary, service, _batch) = service_fixture();
        let mut request = managed_request(&service);
        let install = if change == "instance" {
            request.route = GameFileRouteKind::ManagedLaunch;
            Some(inert_install(&service, &request.port_id, true))
        } else {
            None
        };
        let operation = crate::OperationCoordinator::new("drift-refresh", None);
        let started = std::time::Instant::now();
        let elapsed = || started.elapsed();
        let error = service
            .refresh_game_file_query_with_fence(
                &[request.clone()],
                &refresh_limits(),
                300,
                &QueryFence {
                    elapsed: &elapsed,
                    maximum: std::time::Duration::from_secs(30),
                    operation: Some(&operation),
                },
                || {
                    if let Some(mut install) = install {
                        install.id = "changed-active-instance".into();
                        service.library().register_install(&install, true)?;
                    } else {
                        service
                            .library()
                            .set_channel(&request.port_id, crate::ReleaseChannel::Beta)?;
                    }
                    Ok(())
                },
            )
            .unwrap_err();
        assert_eq!(
            error.code,
            crate::ErrorCode::Conflict,
            "late {change} drift"
        );
    }
}

#[test]
fn late_source_change_during_projection_is_checked_before_refresh_publication() {
    let (temporary, service, _batch) = service_fixture();
    let record = register_inert_query_source(&service, temporary.path().join("input.z64"));
    let operation = crate::OperationCoordinator::new("source-drift-refresh", None);
    let started = std::time::Instant::now();
    let elapsed = || started.elapsed();
    let result = service.refresh_game_file_query_with_fence(
        &[managed_request(&service)],
        &refresh_limits(),
        300,
        &QueryFence {
            elapsed: &elapsed,
            maximum: std::time::Duration::from_secs(30),
            operation: Some(&operation),
        },
        || {
            std::fs::write(&record.path, b"changed")?;
            Ok(())
        },
    );
    assert!(result.is_err());
    assert_eq!(
        service.library().sources().unwrap()[0].sha256,
        record.sha256
    );
}

#[test]
fn deadline_after_projection_discards_result_before_publication() {
    use std::sync::atomic::{AtomicU64, Ordering};
    let (_temporary, service, _batch) = service_fixture();
    let (activity, operation) = service
        .begin_cancellable_activity(
            crate::ActivityOperation::CheckUpdate,
            crate::ActivityTargetKind::Library,
            None,
        )
        .unwrap();
    let clock = AtomicU64::new(0);
    let elapsed = || std::time::Duration::from_millis(clock.load(Ordering::SeqCst));
    let result = service.refresh_game_file_query_with_fence(
        &[managed_request(&service)],
        &refresh_limits(),
        300,
        &QueryFence {
            elapsed: &elapsed,
            maximum: std::time::Duration::from_secs(30),
            operation: Some(&operation),
        },
        || {
            clock.store(30_001, Ordering::SeqCst);
            Ok(())
        },
    );
    assert_eq!(result.unwrap_err().code, crate::ErrorCode::Unsupported);
    assert_eq!(
        crate::cancellation::cancellation_state(service.library(), &activity.id)
            .unwrap()
            .unwrap()
            .phase,
        crate::CancellationPhase::Preparing
    );
}

#[test]
fn cancellation_after_inspection_waits_for_the_actual_blocking_refresh_worker() {
    let (temporary, service, _batch) = service_fixture();
    let record = register_inert_query_source(&service, temporary.path().join("input.z64"));
    let request = managed_request(&service);
    let (activity, operation) = service
        .begin_cancellable_activity(
            crate::ActivityOperation::CheckUpdate,
            crate::ActivityTargetKind::Library,
            None,
        )
        .unwrap();
    let worker_service = PortcoveService::new(service.library().clone()).unwrap();
    let (entered, ready) = std::sync::mpsc::channel();
    let (release, held) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        let started = std::time::Instant::now();
        let elapsed = || started.elapsed();
        worker_service.refresh_game_file_query_with_fence(
            &[request],
            &refresh_limits(),
            300,
            &QueryFence {
                elapsed: &elapsed,
                maximum: std::time::Duration::from_secs(30),
                operation: Some(&operation),
            },
            || {
                entered.send(()).unwrap();
                held.recv_timeout(std::time::Duration::from_secs(10))
                    .unwrap();
                Ok(())
            },
        )
    });
    ready
        .recv_timeout(std::time::Duration::from_secs(10))
        .unwrap();
    service.request_cancellation(&activity.id).unwrap();
    assert!(
        !worker.is_finished(),
        "cancellation acknowledgment cannot imply worker exit"
    );
    let state = crate::cancellation::cancellation_state(service.library(), &activity.id)
        .unwrap()
        .unwrap();
    assert_eq!(state.phase, crate::CancellationPhase::Preparing);
    assert!(state.requested);
    assert_eq!(
        std::fs::read(&record.path).unwrap(),
        b"\x80\x37\x12\x40inert registered-input fixture___"
    );
    release.send(()).unwrap();
    let result = worker.join().unwrap();
    assert_eq!(result.unwrap_err().code, crate::ErrorCode::Cancelled);
    assert_eq!(
        service.library().sources().unwrap()[0].sha256,
        record.sha256
    );
}

#[test]
fn tracked_refresh_settles_cancellation_only_after_worker_exit() {
    let (temporary, service, _batch) = service_fixture();
    let source = register_inert_query_source(&service, temporary.path().join("input.z64"));
    let request = GameFileQueryRefreshRequest {
        routes: vec![managed_request(&service)],
        limits: refresh_limits(),
        maximum_age_seconds: 300,
    };
    let worker_service = PortcoveService::new(service.library().clone()).unwrap();
    let (entered, ready) = std::sync::mpsc::channel();
    let (release, held) = std::sync::mpsc::channel();
    let (events, observed) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        worker_service.refresh_game_file_query_tracked(
            &request,
            |event| events.send(event).unwrap(),
            || {
                entered.send(()).unwrap();
                held.recv_timeout(std::time::Duration::from_secs(10))
                    .unwrap();
                Ok(())
            },
        )
    });
    ready
        .recv_timeout(std::time::Duration::from_secs(10))
        .unwrap();
    let started = observed
        .recv_timeout(std::time::Duration::from_secs(10))
        .unwrap();
    let running = service.library().activities(1).unwrap().remove(0);
    assert_eq!(running.id, started.operation_id);
    assert_eq!(running.operation, crate::ActivityOperation::VerifySource);
    assert_eq!(running.status, crate::ActivityStatus::Running);
    service.request_cancellation(&running.id).unwrap();
    assert!(!worker.is_finished());
    assert!(
        observed.try_recv().is_err(),
        "no terminal event while worker is held"
    );
    assert_eq!(
        service.library().activities(1).unwrap()[0].status,
        crate::ActivityStatus::Running
    );
    release.send(()).unwrap();
    assert_eq!(
        worker.join().unwrap().unwrap_err().code,
        crate::ErrorCode::Cancelled
    );
    let terminal = serde_json::to_value(
        observed
            .recv_timeout(std::time::Duration::from_secs(10))
            .unwrap(),
    )
    .unwrap();
    assert_eq!(terminal["type"], "finished");
    assert_eq!(terminal["result"], "cancelled");
    assert_eq!(
        service.library().activities(1).unwrap()[0].status,
        crate::ActivityStatus::Cancelled
    );
    assert_eq!(
        service.library().sources().unwrap()[0].sha256,
        source.sha256
    );
    assert_eq!(
        std::fs::read(source.path).unwrap(),
        b"\x80\x37\x12\x40inert registered-input fixture___"
    );
}

#[test]
fn refresh_request_rejects_client_authored_observation_batches() {
    let (_temporary, service, batch) = service_fixture();
    let request = GameFileQueryRefreshRequest {
        routes: vec![managed_request(&service)],
        limits: refresh_limits(),
        maximum_age_seconds: 300,
    };
    let mut value = serde_json::to_value(request).unwrap();
    value["batch"] = serde_json::to_value(batch).unwrap();
    assert!(serde_json::from_value::<GameFileQueryRefreshRequest>(value).is_err());
}
