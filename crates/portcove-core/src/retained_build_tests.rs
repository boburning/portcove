use super::*;
use crate::{
    Catalog, LaunchOwnerKind, LaunchSessionPhase, LaunchSessionRecord, ReleaseChannel,
    operation::{
        LifecycleFaultInjector, LifecycleOperation, LifecycleOperationKind, LifecyclePhase,
        OperationStore,
    },
};
use std::{fs, sync::Arc};

fn install(library: &Library, id: &str, bytes: &[u8], active: bool) -> InstallRecord {
    let catalog = Catalog::embedded().unwrap();
    let platform = Platform::current().unwrap();
    let port = catalog.port("starship").unwrap();
    let path = library.versions_dir().join("starship").join(id);
    fs::create_dir_all(&path).unwrap();
    let executable = path.join(&port.executable_hints[&platform][0]);
    fs::create_dir_all(executable.parent().unwrap()).unwrap();
    fs::write(&executable, bytes).unwrap();
    crate::permissions::normalize_archive_entry(&executable, false, true).unwrap();
    let artifact = ArtifactIdentity {
        asset_name: "same-label.zip".into(),
        sha256: hex::encode(Sha256::digest(bytes)),
        size: bytes.len() as u64,
    };
    let qualification =
        crate::InstallQualification::from_catalog(&catalog, "starship", platform).unwrap();
    let (manifest_sha256, selected_executable, runtime) = Installer::new(library.clone())
        .unwrap()
        .create_manifest(id, "starship", "v1", &artifact, &qualification, &path)
        .unwrap();
    let install = InstallRecord {
        id: id.into(),
        port_id: "starship".into(),
        version: "v1".into(),
        path,
        channel: ReleaseChannel::Stable,
        installed_at: Library::now(),
        verified: true,
        staged: !active,
        artifact,
        manifest_sha256,
        selected_executable,
        runtime,
    };
    library.register_install(&install, active).unwrap();
    install
}

fn fixture() -> (tempfile::TempDir, PortcoveService, InstallRecord) {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let first = install(&library, "first", b"first exact accepted runtime", true);
    let service = PortcoveService::new_read_only(library).unwrap();
    (temporary, service, first)
}

fn authorize_bind(
    service: &PortcoveService,
    setup: &str,
    install: &InstallRecord,
) -> crate::DestructiveAuthorization {
    let preview = service
        .preview_retained_build_binding(&install.port_id, setup, &install.id)
        .unwrap();
    service
        .authorize_retained_build_binding(
            &install.port_id,
            setup,
            &install.id,
            &preview.preview_sha256,
        )
        .unwrap()
}

fn bind(service: &PortcoveService, setup: &str, install: &InstallRecord) -> RetainedBuildReference {
    let authorization = authorize_bind(service, setup, install);
    service
        .bind_retained_build(&install.port_id, setup, &install.id, &authorization.token)
        .unwrap()
}

fn authorize_release(service: &PortcoveService, setup: &str) -> crate::DestructiveAuthorization {
    let preview = service
        .preview_retained_build_removal("starship", setup)
        .unwrap();
    service
        .authorize_retained_build_removal("starship", setup, &preview.preview_sha256)
        .unwrap()
}

fn release(service: &PortcoveService, setup: &str) {
    let authorization = authorize_release(service, setup);
    service
        .remove_retained_build_reference("starship", setup, &authorization.token)
        .unwrap();
}

#[test]
fn retained_build_references_span_same_label_different_bytes_and_survive_reopen() {
    let (temporary, service, first) = fixture();
    let customized = bind(&service, "setup-customized", &first);
    let manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(first.path.join(".portcove-manifest.json")).unwrap())
            .unwrap();
    let mut contract = manifest["retained_contract"].clone();
    contract.sort_all_objects();
    assert_eq!(
        customized.build.installed_contract_sha256,
        hex::encode(Sha256::digest(serde_json::to_vec(&contract).unwrap()))
    );
    let second = install(
        service.library(),
        "second",
        b"different bytes with identical display label",
        true,
    );
    let clean = bind(&service, "setup-clean", &second);
    assert_eq!(first.version, second.version);
    assert_ne!(customized.build.artifact, clean.build.artifact);
    assert_ne!(
        customized.build.manifest_sha256,
        clean.build.manifest_sha256
    );
    assert_eq!(
        customized.build.installed_contract_sha256,
        clean.build.installed_contract_sha256
    );
    assert!(customized.build.definition.is_none()); // Actual legacy contract, never invented admission.
    assert!(customized.build.runtime.is_none());
    let inventory = service.retained_builds("starship").unwrap();
    assert_eq!(inventory.builds.len(), 2);
    assert_eq!(
        inventory
            .builds
            .iter()
            .find(|build| build.active)
            .unwrap()
            .install
            .id,
        second.id
    );
    drop(service);
    let reopened =
        PortcoveService::new(Library::open(temporary.path().join("library")).unwrap()).unwrap();
    for (setup, expected) in [("setup-customized", customized), ("setup-clean", clean)] {
        let resolved = reopened.resolve_retained_build("starship", setup).unwrap();
        assert_eq!(resolved.reference, expected);
        assert_eq!(resolved.availability, RetainedBuildAvailability::Verified);
        assert_eq!(resolved.install.unwrap().id, expected.build.install_id);
    }
}

#[test]
fn retained_build_cleanup_requires_every_reference_and_invalidates_old_consent() {
    let (_temporary, service, first) = fixture();
    let preview = service.preview_removal("starship").unwrap();
    let old_consent = service
        .authorize_removal("starship", &preview.preview_sha256)
        .unwrap();
    bind(&service, "custom-a", &first);
    bind(&service, "custom-b", &first);
    assert!(
        service.preview_removal("starship").unwrap_err().details["setup_ids"].contains("custom-a")
    );
    assert!(service.remove("starship", &old_consent.token).is_err());
    assert!(service.library().remove_port("starship").is_err());
    assert!(
        service
            .library()
            .connection()
            .unwrap()
            .execute("DELETE FROM installs WHERE id=?1", [&first.id])
            .is_err()
    );
    release(&service, "custom-a");
    assert!(service.preview_removal("starship").is_err());
    assert!(first.path.exists());
    release(&service, "custom-b");
    assert!(
        first.path.exists(),
        "reference removal never deletes build bytes"
    );
    let preview = service.preview_removal("starship").unwrap();
    let consent = service
        .authorize_removal("starship", &preview.preview_sha256)
        .unwrap();
    service.remove("starship", &consent.token).unwrap();
    assert!(!first.path.exists());
}

#[test]
fn retained_build_rebinding_is_explicit_and_stales_binding_and_release_approval() {
    let (_temporary, service, first) = fixture();
    let initial = bind(&service, "custom", &first);
    let old_release = authorize_release(&service, "custom");
    let aba_release = authorize_release(&service, "custom");
    let second = install(service.library(), "second", b"second runtime", true);
    let stale_bind = authorize_bind(&service, "custom", &first);
    let rebound = bind(&service, "custom", &second);
    assert_eq!(rebound.id, initial.id);
    assert_eq!(rebound.created_at, initial.created_at);
    assert!(rebound.revision > initial.revision);
    assert_ne!(rebound.build, initial.build);
    assert!(
        service
            .bind_retained_build("starship", "custom", &first.id, &stale_bind.token)
            .is_err()
    );
    assert!(
        service
            .remove_retained_build_reference("starship", "custom", &old_release.token)
            .is_err()
    );
    assert_eq!(
        service
            .resolve_retained_build("starship", "custom")
            .unwrap()
            .reference,
        rebound
    );
    let back = bind(&service, "custom", &first);
    assert_eq!(back.build, initial.build);
    assert!(back.revision > rebound.revision);
    let stale = service
        .remove_retained_build_reference("starship", "custom", &aba_release.token)
        .unwrap_err();
    assert!(stale.message.contains("state changed"));
    let consent = authorize_release(&service, "custom");
    service
        .remove_retained_build_reference("starship", "custom", &consent.token)
        .unwrap();
    assert!(
        service
            .remove_retained_build_reference("starship", "custom", &consent.token)
            .is_err()
    );
}

#[test]
fn retained_build_missing_and_changed_bytes_preserve_reference_without_substitution() {
    let (_temporary, service, first) = fixture();
    let reference = bind(&service, "custom", &first);
    let second = install(
        service.library(),
        "second",
        b"healthy alternative with same label",
        true,
    );
    let executable = first.path.join(&first.selected_executable);
    fs::write(&executable, b"corrupted runtime").unwrap();
    let changed = service
        .resolve_retained_build("starship", "custom")
        .unwrap();
    assert_eq!(changed.availability, RetainedBuildAvailability::Changed);
    assert_eq!(changed.reference, reference);
    assert!(changed.install.is_none());
    assert!(changed.gap.unwrap().details["failures"].contains("changed:"));
    assert!(
        service
            .preview_retained_build_binding("starship", "another", &first.id)
            .is_err()
    );
    fs::remove_file(executable).unwrap();
    let missing = service
        .resolve_retained_build("starship", "custom")
        .unwrap();
    assert_eq!(missing.availability, RetainedBuildAvailability::Missing);
    assert_eq!(missing.reference, reference);
    assert!(missing.install.is_none());
    assert!(second.path.exists());
    release(&service, "custom");
    assert!(first.path.exists());
    assert!(second.path.exists());
}

#[test]
fn retained_build_binding_does_not_accept_unverified_or_unretained_contracts() {
    let (_temporary, service, first) = fixture();
    let mut not_accepted = first.clone();
    not_accepted.verified = false;
    service
        .library()
        .register_install(&not_accepted, true)
        .unwrap();
    assert!(
        service
            .preview_retained_build_binding("starship", "custom", &first.id)
            .is_err()
    );
    service.library().register_install(&first, true).unwrap();
    let path = first.path.join(".portcove-manifest.json");
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    manifest["schema_version"] = 5.into();
    manifest
        .as_object_mut()
        .unwrap()
        .remove("retained_contract");
    let bytes = serde_json::to_vec(&manifest).unwrap();
    fs::write(path, &bytes).unwrap();
    not_accepted.verified = true;
    not_accepted.manifest_sha256 = hex::encode(Sha256::digest(bytes));
    service
        .library()
        .register_install(&not_accepted, true)
        .unwrap();
    let error = service
        .preview_retained_build_binding("starship", "custom", &first.id)
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Unsupported);
    assert!(
        references_from(&service.library().connection().unwrap())
            .unwrap()
            .is_empty()
    );
}

#[test]
fn retained_build_references_prevent_identity_rewrite_before_manifest_mutation() {
    let (_temporary, service, first) = fixture();
    bind(&service, "custom", &first);
    let mut rewritten = first.clone();
    rewritten.artifact.sha256 = "b".repeat(64);
    assert!(
        service
            .library()
            .register_install(&rewritten, true)
            .is_err()
    );
    rewritten = first.clone();
    rewritten.manifest_sha256 = "c".repeat(64);
    assert!(
        service
            .library()
            .update_install_manifest(&rewritten)
            .is_err()
    );
    let manifest = fs::read(first.path.join(".portcove-manifest.json")).unwrap();
    let qualification = crate::InstallQualification::from_catalog(
        service.catalog(),
        "starship",
        Platform::current().unwrap(),
    )
    .unwrap();
    assert!(
        Installer::new(service.library().clone())
            .unwrap()
            .refresh_verified_manifest(&first, &qualification)
            .is_err()
    );
    assert_eq!(
        fs::read(first.path.join(".portcove-manifest.json")).unwrap(),
        manifest
    );
    assert_eq!(
        service
            .resolve_retained_build("starship", "custom")
            .unwrap()
            .availability,
        RetainedBuildAvailability::Verified
    );
}

#[test]
fn retained_build_reference_follows_owned_path_relocation_without_rebinding() {
    let (_temporary, service, first) = fixture();
    let reference = bind(&service, "custom", &first);
    let moved = first.path.with_file_name("relocated");
    fs::rename(&first.path, &moved).unwrap();
    let relocated = InstallRecord {
        path: moved.clone(),
        ..first
    };
    service
        .library()
        .register_install(&relocated, true)
        .unwrap();
    let resolved = service
        .resolve_retained_build("starship", "custom")
        .unwrap();
    assert_eq!(resolved.reference, reference);
    assert_eq!(resolved.install.unwrap().path, moved);
}

#[test]
fn retained_build_reference_mutation_respects_active_session_and_operation_locks() {
    let (_temporary, service, first) = fixture();
    bind(&service, "custom", &first);
    let bind_consent = authorize_bind(&service, "another", &first);
    let remove_consent = authorize_release(&service, "custom");
    let session = LaunchSessionRecord {
        id: uuid::Uuid::new_v4().to_string(),
        port_id: "starship".into(),
        install_id: first.id.clone(),
        install_root: first.path.clone(),
        owner_kind: LaunchOwnerKind::Managed,
        supervisor_pid: std::process::id(),
        supervisor_identity: None,
        child_pid: None,
        child_identity: None,
        phase: LaunchSessionPhase::Running,
        outcome: None,
        exit_code: None,
        message: None,
        started_at: Library::now(),
        updated_at: Library::now(),
        finished_at: None,
    };
    service.library().create_launch_session(&session).unwrap();
    assert!(
        service
            .bind_retained_build("starship", "another", &first.id, &bind_consent.token)
            .is_err()
    );
    assert!(
        service
            .remove_retained_build_reference("starship", "custom", &remove_consent.token)
            .is_err()
    );
    service
        .library()
        .connection()
        .unwrap()
        .execute("DELETE FROM launch_sessions WHERE id=?1", [&session.id])
        .unwrap();
    let guard = service
        .library()
        .try_lock_port("starship", "fixture-owner")
        .unwrap();
    assert!(
        service
            .remove_retained_build_reference("starship", "custom", &remove_consent.token)
            .is_err()
    );
    drop(guard);
    service
        .remove_retained_build_reference("starship", "custom", &remove_consent.token)
        .unwrap();
}

#[test]
fn retained_build_references_refuse_outstanding_removal_and_protect_recovery_quarantine() {
    let (_temporary, service, first) = fixture();
    bind(&service, "custom", &first);
    let store = OperationStore::new(service.library().clone());
    let mut operation = LifecycleOperation::new(
        "retained-removal",
        LifecycleOperationKind::Remove,
        "starship",
    );
    operation.paths.quarantine = Some(service.library().recovery_dir().join(&operation.id));
    operation.original_paths.push(first.path.clone());
    let paths = crate::output_root::removal_paths(
        service.library(),
        "starship",
        &operation.id,
        &first.path,
    )
    .unwrap();
    store.put(&mut operation).unwrap();
    assert!(
        service
            .preview_retained_build_binding("starship", "late", &first.id)
            .is_err()
    );
    assert!(
        service
            .preview_retained_build_removal("starship", "custom")
            .is_err()
    );
    assert!(crate::recovery::recover_removal(&service, &store, &mut operation).is_err());
    assert!(first.path.exists());
    fs::create_dir_all(paths.quarantined.parent().unwrap()).unwrap();
    fs::rename(&paths.live, &paths.quarantined).unwrap();
    for phase in [
        LifecyclePhase::PayloadPublished,
        LifecyclePhase::MetadataCommitted,
        LifecyclePhase::CleanupPending,
    ] {
        operation.phase = phase;
        store.put(&mut operation).unwrap();
        assert!(crate::recovery::recover_removal(&service, &store, &mut operation).is_err());
        assert!(paths.quarantined.exists());
        assert!(store.get(&operation.id).unwrap().is_some());
        assert_eq!(
            references_from(&service.library().connection().unwrap())
                .unwrap()
                .len(),
            1
        );
    }
}

struct FailAt(LifecycleFaultPoint);
impl LifecycleFaultInjector for FailAt {
    fn check(&self, point: LifecycleFaultPoint) -> Result<()> {
        if point == self.0 {
            Err(PortcoveError::state(
                "fixture interrupted reference publication",
            ))
        } else {
            Ok(())
        }
    }
}

#[test]
fn retained_build_reference_publication_is_atomic_before_and_after_durable_commit() {
    for point in [
        LifecycleFaultPoint::RetainedBuildBeforeCommit,
        LifecycleFaultPoint::RetainedBuildCommitted,
    ] {
        let (temporary, service, first) = fixture();
        let service =
            PortcoveService::with_faults(service.library().clone(), Arc::new(FailAt(point)))
                .unwrap();
        let consent = authorize_bind(&service, "custom", &first);
        let error = service
            .bind_retained_build("starship", "custom", &first.id, &consent.token)
            .unwrap_err();
        drop(service);
        let reopened =
            PortcoveService::new(Library::open(temporary.path().join("library")).unwrap()).unwrap();
        let references = references_from(&reopened.library().connection().unwrap()).unwrap();
        if point == LifecycleFaultPoint::RetainedBuildBeforeCommit {
            assert!(references.is_empty());
        } else {
            assert_eq!(references.len(), 1);
            assert_eq!(
                error.failure.mutation_state,
                crate::MutationState::Committed
            );
            assert_eq!(
                reopened
                    .resolve_retained_build("starship", "custom")
                    .unwrap()
                    .availability,
                RetainedBuildAvailability::Verified
            );
        }
        assert!(first.path.exists());
    }
}

#[test]
fn retained_build_reference_removal_rolls_back_or_remains_committed_after_interruption() {
    for point in [
        LifecycleFaultPoint::RetainedBuildBeforeCommit,
        LifecycleFaultPoint::RetainedBuildCommitted,
    ] {
        let (_temporary, service, first) = fixture();
        let reference = bind(&service, "custom", &first);
        let faulted =
            PortcoveService::with_faults(service.library().clone(), Arc::new(FailAt(point)))
                .unwrap();
        let consent = authorize_release(&faulted, "custom");
        let error = faulted
            .remove_retained_build_reference("starship", "custom", &consent.token)
            .unwrap_err();
        if point == LifecycleFaultPoint::RetainedBuildBeforeCommit {
            assert_eq!(
                service
                    .resolve_retained_build("starship", "custom")
                    .unwrap()
                    .reference,
                reference
            );
        } else {
            assert!(
                service
                    .resolve_retained_build("starship", "custom")
                    .is_err()
            );
            assert_eq!(
                error.failure.mutation_state,
                crate::MutationState::Committed
            );
        }
        assert!(first.path.exists());
    }
}

#[test]
fn retained_build_cancellation_preserves_previous_reference_and_bytes() {
    let (_temporary, service, first) = fixture();
    let reference = bind(&service, "custom", &first);
    let second = install(service.library(), "second", b"second runtime", true);
    let bind_consent = authorize_bind(&service, "custom", &second);
    let remove_consent = authorize_release(&service, "custom");
    service.request_owned_cancellations().unwrap();
    assert_eq!(
        service
            .bind_retained_build("starship", "custom", &second.id, &bind_consent.token)
            .unwrap_err()
            .code,
        ErrorCode::Cancelled
    );
    assert_eq!(
        service
            .remove_retained_build_reference("starship", "custom", &remove_consent.token)
            .unwrap_err()
            .code,
        ErrorCode::Cancelled
    );
    assert_eq!(
        service
            .resolve_retained_build("starship", "custom")
            .unwrap()
            .reference,
        reference
    );
    assert!(first.path.exists());
    assert!(second.path.exists());
}

#[test]
fn retained_build_corrupt_reference_metadata_never_disables_cleanup_protection() {
    let (_temporary, service, first) = fixture();
    bind(&service, "custom", &first);
    service
        .library()
        .connection()
        .unwrap()
        .execute(
            "UPDATE retained_build_references SET reference_json='{}'",
            [],
        )
        .unwrap();
    assert!(service.retained_builds("starship").is_err());
    assert!(service.preview_removal("starship").is_err());
    assert!(service.library().remove_port("starship").is_err());
    // Corruption of the denormalized port column cannot hide a reference from
    // the installation owner's pre-filesystem cleanup guard either.
    service
        .library()
        .connection()
        .unwrap()
        .execute(
            "UPDATE retained_build_references SET port_id='incorrect-port'",
            [],
        )
        .unwrap();
    assert!(service.preview_removal("starship").is_err());
    assert!(service.library().remove_port("starship").is_err());
    assert!(first.path.exists());
}

#[test]
fn retained_build_reference_detects_reused_record_identity_and_missing_record() {
    let (_temporary, service, first) = fixture();
    let reference = bind(&service, "custom", &first);
    let connection = service.library().connection().unwrap();
    connection
        .execute(
            "UPDATE installs SET artifact_sha256=?1 WHERE id=?2",
            params!["c".repeat(64), first.id],
        )
        .unwrap();
    let changed = service
        .resolve_retained_build("starship", "custom")
        .unwrap();
    assert_eq!(changed.availability, RetainedBuildAvailability::Changed);
    assert_eq!(changed.reference, reference);
    assert!(changed.install.is_none());
    // Simulate corrupt historical metadata outside the supported restrictive FK
    // writer; its surviving reference must still hold cleanup and report the gap.
    connection
        .pragma_update(None, "foreign_keys", "OFF")
        .unwrap();
    connection
        .execute("DELETE FROM installs WHERE id=?1", [&first.id])
        .unwrap();
    let missing = service
        .resolve_retained_build("starship", "custom")
        .unwrap();
    assert_eq!(missing.availability, RetainedBuildAvailability::Missing);
    assert_eq!(missing.reference, reference);
    assert!(service.library().remove_port("starship").is_err());
    assert!(first.path.exists());
}
