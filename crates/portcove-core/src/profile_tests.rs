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
            provider: "gamebanana".into(),
            project: "12345".into(),
            file: Some("67890".into()),
            version: Some("1.0".into()),
        }),
        sha256: "c".repeat(64),
        size: 10,
        enabled: true,
        requires: requires.iter().map(|r| r.to_string()).collect(),
    }
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
    let second = install(service.library(), "second", b"second runtime", true);
    let request = ProfileRevisionRequest {
        expected_revision: 1,
        install_id: Some(second.id.clone()),
        packages: Some(vec![package("mod.a", &[])]),
        ..Default::default()
    };
    let next = service
        .create_profile_revision("starship", &default.id, &request)
        .unwrap();
    assert_eq!((next.revision, next.parent_revision), (2, Some(1)));
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
            "UPDATE profile_revisions SET revision_json=replace(revision_json,'mod.a','mod.z') WHERE revision=2",
            [],
        )
        .unwrap();
    assert!(service.profile_revisions("starship", &default.id).is_err());
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
