use super::*;
use crate::retained_build::tests::{fixture, install};
use crate::{ErrorCode, ObservedSourceIdentity};

fn requirement(service: &PortcoveService) -> String {
    service
        .catalog()
        .port("starship")
        .unwrap()
        .source_profile
        .clone()
        .expect("starship requires an original")
}

fn register_original(service: &PortcoveService, id: &str, sha: char, path: &str) -> SourceRecord {
    let source = SourceRecord {
        profile_id: id.into(),
        path: path.into(),
        sha256: sha.to_string().repeat(64),
        size: 1024,
        storage_sha256: sha.to_string().repeat(64),
        storage_size: 1024,
        updated_at: 1,
        observed_identity: None::<ObservedSourceIdentity>,
    };
    let connection = service.library().connection().unwrap();
    Library::write_source(&connection, &source).unwrap();
    source
}

fn package(id: &str, requires: &[&str]) -> ResolvedPackage {
    ResolvedPackage {
        native_id: id.into(),
        native_version: Some("1.0.0".into()),
        provider: Some(ProviderPackageRef {
            binding: None,
            provider: "gamebanana".into(),
            project: "12345".into(),
            file: Some("67890".into()),
            version: Some("1.0".into()),
        }),
        sha256: "c".repeat(64),
        size: 10,
        enabled: true,
        requires: requires.iter().map(|r| r.to_string()).collect(),
        provider_requires: Vec::new(),
    }
}

#[test]
fn companion_profile_custody_is_typed_but_held_before_any_writer() {
    use crate::profile_package_files::profile_package_files;
    use crate::{Platform, RecompCompanionMemberV1, RecompCompanionRole, RecompCompanionSetV1};

    let (_temporary, service, _) = fixture();
    let req = requirement(&service);
    register_original(&service, &req, 'a', "/games/original.z64");
    service.ensure_default_profile("starship").unwrap();
    let mut revision = service
        .profile_inventory("starship")
        .unwrap()
        .profiles
        .remove(0)
        .revision;
    let legacy = serde_json::to_vec(&revision).unwrap();
    let decoded: ProfileRevision = serde_json::from_slice(&legacy).unwrap();
    assert_eq!(serde_json::to_vec(&decoded).unwrap(), legacy);
    assert!(digest_matches(&decoded).unwrap());
    assert!(decoded.recomp_companion_sets_v1.is_none());
    let mut explicit_null = serde_json::to_value(&decoded).unwrap();
    explicit_null["recomp_companion_sets_v1"] = serde_json::Value::Null;
    assert!(serde_json::from_value::<ProfileRevision>(explicit_null).is_err());

    let nrm = package("example.nrm", &[]);
    revision.loader = Some(crate::profile_loader::ModEngine::N64Recomp.reference());
    revision.build.platform = Platform::LinuxX86_64;
    revision.packages.push(nrm.clone());
    assert_eq!(profile_package_files(&revision).unwrap().len(), 1);
    revision.recomp_companion_sets_v1 = Some(vec![RecompCompanionSetV1 {
        repository: "Author/Mod".into(),
        repository_id: 1,
        release_id: 2,
        asset_id: 3,
        publisher_sha256: Some("a".repeat(64)),
        wrapper_sha256: "a".repeat(64),
        wrapper_size: 25,
        install_id: revision.build.install_id.clone(),
        platform: revision.build.platform,
        consent_sha256: "b".repeat(64),
        members: BTreeMap::from([
            (
                nrm.native_id,
                RecompCompanionMemberV1 {
                    size: nrm.size,
                    sha256: nrm.sha256,
                    role: RecompCompanionRole::Nrm,
                },
            ),
            (
                "example.so".into(),
                RecompCompanionMemberV1 {
                    size: 40,
                    sha256: "d".repeat(64),
                    role: RecompCompanionRole::PrimaryLibrary,
                },
            ),
            (
                "libexample.so.1.0".into(),
                RecompCompanionMemberV1 {
                    size: 50,
                    sha256: "e".repeat(64),
                    role: RecompCompanionRole::BundledLibrary,
                },
            ),
        ]),
    }]);
    let supported_shape = serde_json::to_vec(&revision).unwrap();
    let restored: ProfileRevision = serde_json::from_slice(&supported_shape).unwrap();
    assert_eq!(restored, revision);
    assert_eq!(
        profile_package_files(&restored)
            .unwrap()
            .iter()
            .map(|file| file.name)
            .collect::<Vec<_>>(),
        ["example.nrm", "example.so", "libexample.so.1.0"]
    );
    assert!(
        seal(&mut revision)
            .unwrap_err()
            .to_string()
            .contains("complete managed custody")
    );

    let mut wrong_platform = restored.clone();
    wrong_platform.recomp_companion_sets_v1.as_mut().unwrap()[0].platform = Platform::WindowsX86_64;
    assert!(profile_package_files(&wrong_platform).is_err());
    let mut changed_nrm = restored.clone();
    changed_nrm.packages[0].sha256 = "e".repeat(64);
    assert!(profile_package_files(&changed_nrm).is_err());
    let mut colliding = restored;
    let members = &mut colliding.recomp_companion_sets_v1.as_mut().unwrap()[0].members;
    members.insert("EXAMPLE.SO".into(), members["example.so"].clone());
    assert!(profile_package_files(&colliding).is_err());
}

#[test]
fn legacy_active_install_migrates_to_one_idempotent_default_profile() {
    let (_temporary, service, first) = fixture();
    let req = requirement(&service);
    register_original(&service, &req, 'a', "/games/original.z64");
    let profile = service.ensure_default_profile("starship").unwrap();
    assert!(profile.is_default);
    assert_eq!(profile.current_revision, 1);
    assert_eq!(service.ensure_default_profile("starship").unwrap(), profile);
    let inventory = service.profile_inventory("starship").unwrap();
    assert_eq!(inventory.profiles.len(), 1);
    let view = &inventory.profiles[0];
    assert_eq!(view.revision.build.install_id, first.id);
    assert_eq!(view.build_availability, RetainedBuildAvailability::Verified);
    assert_eq!(
        view.originals[0].availability,
        OriginalAvailability::Verified
    );
    // Profile identity is independent of its name, source profile and install ID.
    assert_ne!(profile.id, first.id);
    assert_ne!(profile.id, req);
    // The retained reference is keyed by the profile ID, so cleanup protection follows.
    assert!(
        service
            .resolve_retained_build("starship", &profile.id)
            .is_ok()
    );
    assert!(service.preview_removal("starship").is_err());
}

#[test]
fn original_binding_survives_relocation_and_flags_changed_or_missing_originals() {
    let (_temporary, service, _first) = fixture();
    let req = requirement(&service);
    register_original(&service, &req, 'a', "/old/location.z64");
    let profile = service.ensure_default_profile("starship").unwrap();
    // Same bytes registered at a new path remain the same original.
    register_original(&service, &req, 'a', "/new/location.z64");
    let view = &service.profile_inventory("starship").unwrap().profiles[0];
    assert_eq!(
        view.originals[0].availability,
        OriginalAvailability::Verified
    );
    // A different original under the same requirement is never silently substituted.
    register_original(&service, &req, 'b', "/new/location.z64");
    let view = &service.profile_inventory("starship").unwrap().profiles[0];
    assert_eq!(
        view.originals[0].availability,
        OriginalAvailability::Changed
    );
    service
        .library()
        .connection()
        .unwrap()
        .execute("DELETE FROM sources", [])
        .unwrap();
    let view = &service.profile_inventory("starship").unwrap().profiles[0];
    assert_eq!(
        view.originals[0].availability,
        OriginalAvailability::Missing
    );
    assert_eq!(view.profile.id, profile.id);
    assert_eq!(
        view.revision.revision, 1,
        "missing originals never rewrite the revision"
    );
}

#[test]
fn two_profiles_keep_different_originals_for_the_same_requirement() {
    let (_temporary, service, _first) = fixture();
    let req = requirement(&service);
    register_original(&service, &req, 'a', "/a.z64");
    let default = service.ensure_default_profile("starship").unwrap();
    let copy = service
        .copy_profile("starship", &default.id, "Other region")
        .unwrap();
    assert!(!copy.is_default);
    register_original(&service, &req, 'b', "/b.z64");
    let mut request = ProfileRevisionRequest {
        expected_revision: 1,
        ..Default::default()
    };
    request.packages = Some(vec![package("mod.a", &[])]);
    service
        .create_profile_revision("starship", &copy.id, &request)
        .unwrap();
    let inventory = service.profile_inventory("starship").unwrap();
    let by_id = |id: &str| {
        inventory
            .profiles
            .iter()
            .find(|v| v.profile.id == id)
            .unwrap()
    };
    // Both still name the original they were created with, not the newest registry entry.
    assert_eq!(
        by_id(&default.id).revision.originals[0].sha256,
        "a".repeat(64)
    );
    assert_eq!(by_id(&copy.id).revision.originals[0].sha256, "a".repeat(64));
    assert_ne!(
        by_id(&default.id).revision.save_group,
        by_id(&copy.id).revision.save_group
    );
}

#[test]
fn revisions_are_append_only_exact_and_keep_the_older_build_recoverable() {
    let (_temporary, service, first) = fixture();
    let default = service.ensure_default_profile("starship").unwrap();
    let second = install(service.library(), "second", b"second runtime", false);
    service.library().activate_staged("starship").unwrap();
    let request = ProfileRevisionRequest {
        expected_revision: 2,
        install_id: Some(second.id.clone()),
        packages: Some(vec![package("mod.a", &[])]),
        ..Default::default()
    };
    let next = service
        .create_profile_revision("starship", &default.id, &request)
        .unwrap();
    assert_eq!((next.revision, next.parent_revision), (3, Some(2)));
    let revisions = service.profile_revisions("starship", &default.id).unwrap();
    assert_eq!(revisions[0].build.install_id, first.id);
    assert_eq!(revisions[1].build.install_id, second.id);
    assert_eq!(revisions[0].save_group, revisions[1].save_group);
    // The first revision's build stays protected through the retained history.
    let resolved = service
        .resolve_retained_build("starship", &default.id)
        .unwrap();
    assert_eq!(resolved.history[0].revision.build.install_id, first.id);
    assert!(service.preview_removal("starship").is_err());
    // A stale reviewer cannot overwrite the newer revision.
    let stale = service
        .create_profile_revision("starship", &default.id, &request)
        .unwrap_err();
    assert_eq!(stale.code, ErrorCode::Conflict);
    // Stored revisions detect tampering.
    service
        .library()
        .connection()
        .unwrap()
        .execute(
            "UPDATE profile_revisions SET revision_json=replace(revision_json,'mod.a','mod.z') WHERE revision=3",
            [],
        )
        .unwrap();
    assert!(service.profile_revisions("starship", &default.id).is_err());
}

#[test]
fn default_copy_and_recipe_follow_activation_and_rollback_while_custom_stays_pinned() {
    let (_temporary, service, first) = fixture();
    let port_id = &first.port_id;
    let default = service.ensure_default_profile(port_id).unwrap();
    let custom = service
        .copy_profile(port_id, &default.id, "Pinned")
        .unwrap();
    let second = install(service.library(), "second", b"new runtime", false);

    let inactive = ProfileRevisionRequest {
        expected_revision: 1,
        install_id: Some(second.id.clone()),
        ..Default::default()
    };
    assert!(
        service
            .create_profile_revision(port_id, &default.id, &inactive)
            .is_err()
    );

    service.library().activate_staged(port_id).unwrap();
    let recipe = service
        .export_profile_recipe(port_id, &default.id, None)
        .unwrap();
    assert_eq!(recipe.runtime.artifact, second.artifact);
    let copied = service
        .copy_profile(port_id, &default.id, "Current copy")
        .unwrap();
    assert_eq!(
        service.profile_revisions(port_id, &copied.id).unwrap()[0]
            .build
            .install_id,
        second.id
    );
    assert_eq!(
        service.profile_revisions(port_id, &custom.id).unwrap()[0]
            .build
            .install_id,
        first.id
    );
    let connection = service.library().connection().unwrap();
    assert_eq!(
        selection(&connection, port_id).unwrap(),
        Some((default.id.clone(), 2))
    );

    service.library().rollback(port_id).unwrap();
    let revisions = service.profile_revisions(port_id, &default.id).unwrap();
    assert_eq!(revisions.len(), 3);
    assert_eq!(revisions[2].build.install_id, first.id);
    assert_eq!(revisions[2].save_group, revisions[0].save_group);
    let retained = service
        .resolve_retained_build(port_id, &default.id)
        .unwrap();
    assert_eq!(retained.history[0].revision.build.install_id, second.id);
    let recipe = service
        .export_profile_recipe(port_id, &default.id, None)
        .unwrap();
    assert_eq!(recipe.runtime.artifact, first.artifact);
}

#[test]
fn rollback_preserves_an_older_default_offer_when_its_registered_identity_changed() {
    let (_temporary, service, first) = fixture();
    let port_id = &first.port_id;
    let library = service.library();
    let default = service.ensure_default_profile(port_id).unwrap();
    let second = install(library, "second", b"new runtime", true);

    // Simulate a legacy record whose install ID now identifies a different
    // manifest. Current bound-install writers already refuse this mutation.
    let path = first.path.join(".portcove-manifest.json");
    let mut bytes = std::fs::read(&path).unwrap();
    bytes.push(b'\n');
    std::fs::write(path, &bytes).unwrap();
    let connection = library.connection().unwrap();
    connection
        .execute(
            "UPDATE installs SET manifest_sha256=?2 WHERE id=?1",
            params![first.id, hex::encode(Sha256::digest(bytes))],
        )
        .unwrap();

    let error = library.rollback(port_id).unwrap_err();
    assert_eq!(error.code, ErrorCode::Conflict);
    let status = library
        .status(port_id, crate::ReleaseChannel::Stable)
        .unwrap();
    assert_eq!(status.active.unwrap().id, second.id);
    let revisions = service.profile_revisions(port_id, &default.id).unwrap();
    assert_eq!(revisions.len(), 2);
    assert_eq!(revisions[0].build.manifest_sha256, first.manifest_sha256);
    let reference = crate::retained_build::reference_from(&connection, port_id, &default.id)
        .unwrap()
        .unwrap();
    assert_eq!(reference.history[0].build, revisions[0].build);
}

#[test]
fn default_refresh_repairs_a_legacy_active_pointer_without_rewriting_history() {
    let (_temporary, service, first) = fixture();
    let port_id = &first.port_id;
    let default = service.ensure_default_profile(port_id).unwrap();
    let second = install(service.library(), "second", b"new runtime", false);
    let connection = service.library().connection().unwrap();
    connection
        .execute(
            "UPDATE port_settings SET active_install_id=?2 WHERE port_id=?1",
            params![port_id, second.id],
        )
        .unwrap();
    assert!(
        service
            .export_profile_recipe(port_id, &default.id, None)
            .is_err()
    );
    assert!(service.copy_profile(port_id, &default.id, "Stale").is_err());
    let updated = service.ensure_default_profile(port_id).unwrap();
    assert_eq!(updated.current_revision, 2);
    assert_eq!(service.ensure_default_profile(port_id).unwrap(), updated);
    let revisions = service.profile_revisions(port_id, &default.id).unwrap();
    assert_eq!(revisions[0].build.install_id, first.id);
    assert_eq!(revisions[1].build.install_id, second.id);
}

#[test]
fn retiring_an_offered_default_build_frees_a_slot_and_keeps_history_portable() {
    use crate::{
        ReleaseChannel,
        operation::{LifecycleOperation, LifecycleOperationKind, LifecyclePhase, OperationStore},
        retained_build::MAX_OFFERED_REVISIONS,
    };

    let (_temporary, service, first) = fixture();
    let port_id = &first.port_id;
    let library = service.library();
    let default = service.ensure_default_profile(port_id).unwrap();
    let mut current = first.clone();
    for number in 0..MAX_OFFERED_REVISIONS {
        let id = format!("runtime-{number}");
        current = install(library, &id, id.as_bytes(), true);
    }
    let next = install(library, "next", b"next runtime", false);
    let connection = library.connection().unwrap();
    let cap = require_default_recovery_capacity(&connection, port_id, &next.id).unwrap_err();
    assert_eq!(cap.code, ErrorCode::Conflict);
    assert!(library.activate_staged(port_id).is_err());
    let status = library.status(port_id, ReleaseChannel::Stable).unwrap();
    assert_eq!(status.active.unwrap().id, current.id);
    assert_eq!(status.staged.unwrap().id, next.id);
    assert!(
        service
            .preview_retained_build_removal(port_id, &default.id)
            .is_err()
    );
    assert!(
        service
            .preview_retained_build_binding(port_id, &default.id, &next.id)
            .is_err()
    );

    // An already materialized historical revision keeps its build until the
    // player switches away. Current Default activation advances this selection.
    set_selection(&connection, port_id, &default.id, 1).unwrap();
    assert!(
        service
            .preview_retained_build_revision_retirement(port_id, &default.id, 1)
            .is_err()
    );
    let current_revision = profile_from(&connection, port_id, &default.id)
        .unwrap()
        .current_revision;
    set_selection(&connection, port_id, &default.id, current_revision).unwrap();

    // An interrupted install whose own new build is independent of the offer
    // can wait for a slot. The player can retire the offer under the port lock.
    let store = OperationStore::new(library.clone());
    let mut pending = LifecycleOperation::new(&next.id, LifecycleOperationKind::Install, port_id);
    pending.install = Some(next.clone());
    pending.activate = true;
    pending.phase = LifecyclePhase::PayloadPublished;
    store.put(&mut pending).unwrap();
    let plan = service
        .preview_retained_build_revision_retirement(port_id, &default.id, 1)
        .unwrap();
    let authorization = service
        .authorize_retained_build_revision_retirement(port_id, &default.id, 1, &plan.preview_sha256)
        .unwrap();
    let retired = service
        .retire_retained_build_revision(port_id, &default.id, 1, &authorization.token)
        .unwrap();
    assert_eq!(retired.build.install_id, first.id);
    assert!(store.get(&pending.id).unwrap().is_some());
    store.remove(&pending.id).unwrap();

    service.library().activate_staged(port_id).unwrap();
    let profiles = export(&connection).unwrap();
    let references = crate::retained_build::references_from(&connection).unwrap();
    assert!(has_retired_history(&profiles, &references));
    assert!(validate_export(&profiles, &references, false).is_err());
    validate_export(&profiles, &references, true).unwrap();
    assert_eq!(profiles[0].revisions[0].build.install_id, first.id);
    assert_eq!(
        profiles[0].revisions.last().unwrap().build.install_id,
        next.id
    );
    assert!(first.path.is_dir());
}

#[test]
fn invalid_revisions_are_rejected_without_changing_the_profile() {
    let (_temporary, service, _first) = fixture();
    let default = service.ensure_default_profile("starship").unwrap();
    let bad = |mutate: &dyn Fn(&mut ProfileRevisionRequest)| {
        let mut request = ProfileRevisionRequest {
            expected_revision: 1,
            ..Default::default()
        };
        mutate(&mut request);
        service
            .create_profile_revision("starship", &default.id, &request)
            .unwrap_err()
    };
    // Enabled package with a missing native dependency.
    assert_eq!(
        bad(&|r| r.packages = Some(vec![package("mod.a", &["mod.missing"])])).code,
        ErrorCode::Conflict
    );
    // Duplicate native IDs.
    bad(&|r| r.packages = Some(vec![package("mod.a", &[]), package("mod.a", &[])]));
    // Ordering naming a package absent from the revision.
    bad(&|r| {
        r.packages = Some(vec![package("mod.a", &[])]);
        r.orderings = Some(vec![TypedOrdering {
            domain: "load".into(),
            native_ids: vec!["mod.b".into()],
        }]);
    });
    // Unknown build.
    bad(&|r| r.install_id = Some("missing".into()));
    let view = &service.profile_inventory("starship").unwrap().profiles[0];
    assert_eq!(view.profile.current_revision, 1);
    assert_eq!(
        service
            .profile_revisions("starship", &default.id)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn update_policy_is_persisted_intent_separate_from_revisions() {
    let (_temporary, service, _first) = fixture();
    let default = service.ensure_default_profile("starship").unwrap();
    assert_eq!(
        default.intent.update_policy,
        ProfileUpdatePolicy::ReviewUpdates
    );
    let updated = service
        .set_profile_update_policy("starship", &default.id, ProfileUpdatePolicy::KeepCurrent)
        .unwrap();
    assert_eq!(updated.current_revision, 1);
    let reopened = service.profile_inventory("starship").unwrap();
    assert_eq!(
        reopened.profiles[0].profile.intent.update_policy,
        ProfileUpdatePolicy::KeepCurrent
    );
    assert_eq!(
        service
            .profile_revisions("starship", &default.id)
            .unwrap()
            .len(),
        1
    );
}
