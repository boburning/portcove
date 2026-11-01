use super::*;
use std::fs;

#[cfg(windows)]
fn cvlod_junction_fixture(staging: &std::path::Path, target: &std::path::Path) {
    let cache = staging.join(crate::legacy_cartridge_cleanup::CACHE);
    fs::create_dir_all(&cache).unwrap();
    fs::create_dir_all(target).unwrap();
    fs::write(target.join("sentinel"), b"preserve target").unwrap();
    let link = cache.join("Content.IE5");
    let output = crate::ChildProcessPolicy::native_command(
        crate::ChildProcessClass::HostTool,
        std::path::Path::new("cmd.exe"),
    )
    .unwrap()
    .args(["/d", "/c", "mklink", "/J"])
    // mklink is a cmd builtin: forward slashes are parsed as switches,
    // even when PathBuf produced them from our portable cache constant.
    .arg(link.to_str().unwrap().replace('/', "\\"))
    .arg(target.to_str().unwrap().replace('/', "\\"))
    .output()
    .unwrap();
    assert!(output.status.success(), "junction fixture: {output:?}");
    let output = crate::ChildProcessPolicy::native_command(
        crate::ChildProcessClass::HostTool,
        std::path::Path::new("icacls.exe"),
    )
    .unwrap()
    .arg(&link)
    .args(["/L", "/deny", "*S-1-1-0:(RD)"])
    .output()
    .unwrap();
    assert!(
        output.status.success(),
        "owned deny-list fixture: {output:?}"
    );
}

#[cfg(windows)]
#[test]
fn cvlod_private_cleanup_unlinks_exact_denied_junction_without_touching_target() {
    let temporary = tempfile::tempdir().unwrap();
    let staging = temporary.path().join("private");
    let cache = staging.join(crate::legacy_cartridge_cleanup::CACHE);
    let target = cache.join("IE");
    cvlod_junction_fixture(&staging, &target);
    crate::legacy_cartridge_cleanup::unlink_private_wininet_junction(&staging).unwrap();
    assert!(fs::symlink_metadata(cache.join("Content.IE5")).is_err());
    assert_eq!(
        fs::read(target.join("sentinel")).unwrap(),
        b"preserve target"
    );
}

#[cfg(windows)]
#[test]
fn cvlod_private_cleanup_retains_foreign_target_and_redirected_ancestor() {
    for redirected_ancestor in [false, true] {
        let temporary = tempfile::tempdir().unwrap();
        let staging = temporary.path().join("private");
        let cache = staging.join(crate::legacy_cartridge_cleanup::CACHE);
        let foreign = temporary.path().join("foreign");
        cvlod_junction_fixture(&staging, &foreign);
        if redirected_ancestor {
            // Move the owned cache, then redirect its expected ancestor to it.
            fs::rename(&cache, temporary.path().join("redirected-cache")).unwrap();
            let output = crate::ChildProcessPolicy::native_command(
                crate::ChildProcessClass::HostTool,
                std::path::Path::new("cmd.exe"),
            )
            .unwrap()
            .args(["/d", "/c", "mklink", "/J"])
            .arg(cache.to_str().unwrap().replace('/', "\\"))
            .arg(
                temporary
                    .path()
                    .join("redirected-cache")
                    .to_str()
                    .unwrap()
                    .replace('/', "\\"),
            )
            .output()
            .unwrap();
            assert!(output.status.success(), "ancestor junction: {output:?}");
        }
        assert!(
            crate::legacy_cartridge_cleanup::unlink_private_wininet_junction(&staging).is_err()
        );
        assert_eq!(
            fs::read(foreign.join("sentinel")).unwrap(),
            b"preserve target"
        );
        // Unlink only fixture-owned junction entries before TempDir cleanup.
        if redirected_ancestor {
            fs::remove_dir(&cache).unwrap();
            fs::remove_dir(temporary.path().join("redirected-cache/Content.IE5")).unwrap();
        } else {
            fs::remove_dir(cache.join("Content.IE5")).unwrap();
        }
    }
}

#[cfg(windows)]
#[test]
fn cvlod_private_cleanup_requires_exact_owner_and_durable_quiescence() {
    for (port, quiesced) in [
        ("cvlod-recomp", Some(false)),
        ("cvlod-recomp", None),
        ("sample", Some(true)),
        ("cvlod-recomp", Some(true)),
    ] {
        let (_temporary, service, _operation, mut journal) = fixture(
            ActivityOperation::Install,
            LifecyclePhase::CleanupPending,
            quiesced,
        );
        journal.port_id = port.into();
        let store = OperationStore::new(service.library().clone());
        store.put(&mut journal).unwrap();
        let staging = journal.paths.staging.as_ref().unwrap();
        let cache = staging.join(crate::legacy_cartridge_cleanup::CACHE);
        cvlod_junction_fixture(staging, &cache.join("IE"));
        let result = discard_private_install(service.library(), &journal);
        if port == "cvlod-recomp" && quiesced == Some(true) {
            result.unwrap();
            assert!(!staging.exists());
            assert!(store.get(&journal.id).unwrap().is_none());
        } else {
            assert!(
                result.is_err(),
                "unproven/non-CV cleanup used the exception"
            );
            assert!(
                fs::symlink_metadata(cache.join("Content.IE5"))
                    .unwrap()
                    .file_type()
                    .is_symlink()
            );
            assert!(store.get(&journal.id).unwrap().is_some());
            fs::remove_dir(cache.join("Content.IE5")).unwrap();
        }
    }
}

#[cfg(windows)]
#[test]
fn cvlod_published_cleanup_and_recovery_unlink_only_the_owned_cache_junction() {
    for recovery in [false, true] {
        let (_temporary, service, _worker, mut journal) = published_fixture();
        let library = service.library();
        let staging = journal.paths.staging.clone().unwrap();
        let destination = journal.install.as_ref().unwrap().path.clone();
        let cache = staging.join(crate::legacy_cartridge_cleanup::CACHE);
        let store = OperationStore::new(library.clone());
        if recovery {
            journal.phase = LifecyclePhase::CleanupPending;
            store.put(&mut journal).unwrap();
            let _lock = library
                .try_lock_port("cvlod-recomp", "test-recovery")
                .unwrap();
            crate::recovery::recover_published_install(&service, &store, &mut journal).unwrap();
            assert!(!staging.exists());
            assert!(store.get(&journal.id).unwrap().is_none());
        } else {
            crate::legacy_cartridge_cleanup::unlink_published_private_wininet_junction(
                library, &journal, &staging,
            )
            .unwrap();
            assert!(fs::symlink_metadata(cache.join("Content.IE5")).is_err());
            assert_eq!(
                fs::read(cache.join("IE/sentinel")).unwrap(),
                b"preserve target"
            );
            fs::remove_dir_all(&staging).unwrap();
        }
        assert_eq!(
            fs::read(destination.join("sentinel")).unwrap(),
            b"published payload"
        );
        assert_eq!(
            library
                .status("cvlod-recomp", crate::ReleaseChannel::Stable)
                .unwrap()
                .active
                .unwrap()
                .id,
            journal.id
        );
    }
}

#[cfg(windows)]
#[test]
fn cvlod_published_cleanup_refuses_unproven_ownership_before_unlinking() {
    for changed in [
        "quiescence",
        "unknown_quiescence",
        "phase",
        "kind",
        "owner",
        "install",
        "staging",
        "install_owner",
        "install_id",
        "final",
        "committed",
    ] {
        let (_temporary, service, _worker, mut journal) = published_fixture();
        let staging = journal.paths.staging.clone().unwrap();
        let cache = staging.join(crate::legacy_cartridge_cleanup::CACHE);
        // These malformed publication records must refuse before any filesystem mutation.
        match changed {
            "quiescence" => journal.preparation_process_quiesced = Some(false),
            "phase" => journal.phase = LifecyclePhase::Preparing,
            "kind" => journal.kind = LifecycleOperationKind::Adopt,
            "owner" => journal.port_id = "sample".into(),
            "staging" => journal.paths.staging = None,
            "install" => journal.install = None,
            "unknown_quiescence" => journal.preparation_process_quiesced = None,
            "install_owner" => journal.install.as_mut().unwrap().port_id = "sample".into(),
            "install_id" => journal.install.as_mut().unwrap().id = "changed".into(),
            "final" => journal.paths.final_path = None,
            "committed" => journal.install.as_mut().unwrap().manifest_sha256 = "f".repeat(64),
            _ => unreachable!(),
        }
        assert!(
            crate::legacy_cartridge_cleanup::unlink_published_private_wininet_junction(
                service.library(),
                &journal,
                &staging,
            )
            .is_err()
        );
        assert!(
            fs::symlink_metadata(cache.join("Content.IE5"))
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(
            fs::read(cache.join("IE/sentinel")).unwrap(),
            b"preserve target"
        );
        fs::remove_dir(cache.join("Content.IE5")).unwrap();
    }
}

#[cfg(windows)]
fn published_fixture() -> (
    tempfile::TempDir,
    PortcoveService,
    OperationCoordinator,
    LifecycleOperation,
) {
    let (temporary, service, worker, mut journal) = fixture(
        ActivityOperation::Install,
        LifecyclePhase::Preparing,
        Some(true),
    );
    let library = service.library();
    journal.port_id = "cvlod-recomp".into();
    let staging = journal.paths.staging.clone().unwrap();
    let destination = library.versions_dir().join("cvlod-recomp/test");
    fs::create_dir_all(&destination).unwrap();
    fs::write(destination.join("sentinel"), b"published payload").unwrap();
    let install = crate::InstallRecord {
        id: journal.id.clone(),
        port_id: journal.port_id.clone(),
        version: "test".into(),
        path: destination.clone(),
        channel: crate::ReleaseChannel::Stable,
        installed_at: 1,
        verified: true,
        staged: false,
        artifact: Default::default(),
        runtime: None,
        manifest_sha256: "0".repeat(64),
        selected_executable: "sentinel".into(),
    };
    library.register_install(&install, true).unwrap();
    journal.paths.final_path = Some(destination.clone());
    journal.install = Some(install);
    journal.phase = LifecyclePhase::MetadataCommitted;
    let cache = staging.join(crate::legacy_cartridge_cleanup::CACHE);
    cvlod_junction_fixture(&staging, &cache.join("IE"));
    let store = OperationStore::new(library.clone());
    store.put(&mut journal).unwrap();
    (temporary, service, worker, journal)
}

fn fixture(
    activity_kind: ActivityOperation,
    phase: LifecyclePhase,
    quiesced: Option<bool>,
) -> (
    tempfile::TempDir,
    PortcoveService,
    OperationCoordinator,
    LifecycleOperation,
) {
    let temporary = tempfile::tempdir().unwrap();
    let library = crate::test_fixture::phase("builder fixture: open library", || {
        Library::open(temporary.path().join("library")).unwrap()
    });
    let service =
        crate::test_fixture::phase("builder fixture: initialize recovery service", || {
            PortcoveService::new(library).unwrap()
        });
    let (activity, operation) = service
        .begin_cancellable_activity(activity_kind, ActivityTargetKind::Port, Some("sample"))
        .unwrap();
    let mut journal =
        LifecycleOperation::new(&activity.id, LifecycleOperationKind::Install, "sample");
    journal.phase = phase;
    journal.preparation_process_quiesced = quiesced;
    let staging = service.library().staging_dir().join(&activity.id);
    fs::create_dir_all(&staging).unwrap();
    fs::write(staging.join("owned-private"), b"retained builder input").unwrap();
    journal.paths.staging = Some(staging);
    OperationStore::new(service.library().clone())
        .put(&mut journal)
        .unwrap();
    (temporary, service, operation, journal)
}

#[test]
fn interrupted_builder_checks_fresh_journal_and_activity_ownership() {
    for changed_field in [
        "owner",
        "created",
        "phase",
        "staging",
        "final",
        "quarantine",
        "kind",
    ] {
        eprintln!("builder ownership case: {changed_field}");
        let (_temporary, service, _operation, original) = fixture(
            ActivityOperation::Install,
            LifecyclePhase::Preparing,
            Some(false),
        );
        let _port = service
            .library()
            .try_lock_port("sample", "owned-recovery-test")
            .unwrap();
        let store = OperationStore::new(service.library().clone());
        let mut changed = original.clone();
        match changed_field {
            "owner" => changed.port_id = "different-owner".into(),
            "created" => changed.created_at += 1,
            "phase" => changed.phase = LifecyclePhase::Prepared,
            "staging" => {
                changed.paths.staging = Some(service.library().staging_dir().join("changed"))
            }
            "final" => {
                changed.paths.final_path = Some(service.library().versions_dir().join("changed"))
            }
            "quarantine" => {
                changed.paths.quarantine =
                    Some(service.library().staging_dir().join("changed-quarantine"))
            }
            "kind" => changed.kind = LifecycleOperationKind::Prepare,
            _ => unreachable!(),
        }
        if changed_field == "created" {
            // Upsert preserves created_at. Reinsert the owned row to
            // simulate identifier reuse, rather than an ineffective update.
            store.remove(&original.id).unwrap();
        }
        if changed_field == "phase" {
            assert_eq!(store.put(&mut changed).unwrap_err().code, ErrorCode::State);
            // A missing required payload is malformed retained input, not a
            // state the checked writer can construct. Exercise the codec below it.
            database::connect(service.library().root())
                .unwrap()
                .execute(
                    "UPDATE lifecycle_operations SET phase='prepared' WHERE id=?1",
                    [&original.id],
                )
                .unwrap();
        } else {
            store.put(&mut changed).unwrap();
        }
        assert_eq!(
            interrupted_install_journal(service.library(), &store, &original)
                .unwrap_err()
                .code,
            if changed_field == "phase" {
                ErrorCode::State
            } else {
                ErrorCode::Verification
            }
        );
        assert!(
            original
                .paths
                .staging
                .as_ref()
                .unwrap()
                .join("owned-private")
                .is_file()
        );
        if changed_field == "phase" {
            assert!(store.get(&original.id).is_err());
            let retained: (String, Option<String>) = database::connect(service.library().root())
                .unwrap()
                .query_row(
                    "SELECT phase,install_json FROM lifecycle_operations WHERE id=?1",
                    [&original.id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            assert_eq!(retained, ("prepared".into(), None));
        } else {
            assert!(store.get(&original.id).unwrap().is_some());
        }
    }
    for wrong_activity in ["port", "operation"] {
        eprintln!("builder activity-ownership case: {wrong_activity}");
        let (_temporary, service, _operation, journal) = fixture(
            ActivityOperation::Install,
            LifecyclePhase::Preparing,
            Some(false),
        );
        let _port = service
            .library()
            .try_lock_port("sample", "owned-recovery-test")
            .unwrap();
        let sql = if wrong_activity == "port" {
            "UPDATE activity_history SET target_id='different-port' WHERE id=?1"
        } else {
            "UPDATE activity_history SET operation='register-source' WHERE id=?1"
        };
        database::connect(service.library().root())
            .unwrap()
            .execute(sql, [&journal.id])
            .unwrap();
        let store = OperationStore::new(service.library().clone());
        let error = interrupted_install_journal(service.library(), &store, &journal).unwrap_err();
        assert_eq!(error.code, ErrorCode::Verification);
        assert!(!error.details.contains_key("cleanup_hold"));
        assert!(journal.paths.staging.as_ref().unwrap().is_dir());
    }
}

#[test]
fn interrupted_builder_uses_current_proof_and_skips_retired_journal() {
    let (_temporary, service, _operation, original) = fixture(
        ActivityOperation::Install,
        LifecyclePhase::Preparing,
        Some(false),
    );
    let _port = service
        .library()
        .try_lock_port("sample", "owned-recovery-test")
        .unwrap();
    let store = OperationStore::new(service.library().clone());
    let mut completed = original.clone();
    completed.preparation_process_quiesced = Some(true);
    store.put(&mut completed).unwrap();
    let fresh = interrupted_install_journal(service.library(), &store, &original)
        .unwrap()
        .unwrap();
    assert_eq!(fresh.preparation_process_quiesced, Some(true));
    store.remove(&original.id).unwrap();
    assert!(
        interrupted_install_journal(service.library(), &store, &original)
            .unwrap()
            .is_none()
    );
    assert!(original.paths.staging.as_ref().unwrap().is_dir());
}

#[test]
fn tracked_builder_publication_metadata_is_a_hard_envelope_error() {
    let (_temporary, service, _operation, mut journal) = fixture(
        ActivityOperation::Install,
        LifecyclePhase::Preparing,
        Some(false),
    );
    journal.install = Some(crate::InstallRecord {
        id: "owned-install".into(),
        port_id: "sample".into(),
        version: "v1".into(),
        path: service.library().versions_dir().join("sample"),
        channel: crate::ReleaseChannel::Stable,
        installed_at: 1,
        verified: true,
        staged: true,
        artifact: crate::ArtifactIdentity {
            asset_name: "owned.zip".into(),
            sha256: "a".repeat(64),
            size: 1,
        },
        runtime: None,
        manifest_sha256: "b".repeat(64),
        selected_executable: "owned.exe".into(),
    });
    let error = discard_private_install(service.library(), &journal).unwrap_err();
    assert_eq!(error.code, ErrorCode::Conflict);
    assert!(!error.details.contains_key("cleanup_hold"));
    assert!(
        journal
            .paths
            .staging
            .as_ref()
            .unwrap()
            .join("owned-private")
            .is_file()
    );
    assert!(
        OperationStore::new(service.library().clone())
            .get(&journal.id)
            .unwrap()
            .is_some()
    );
}

#[cfg(unix)]
#[test]
fn tracked_builder_symlink_error_preserves_external_tree_and_journal() {
    let (temporary, service, _operation, journal) = fixture(
        ActivityOperation::Install,
        LifecyclePhase::Preparing,
        Some(false),
    );
    let external = temporary.path().join("external");
    fs::create_dir(&external).unwrap();
    fs::write(external.join("sentinel"), b"external bytes").unwrap();
    let staging = journal.paths.staging.as_ref().unwrap();
    fs::remove_dir_all(staging).unwrap();
    std::os::unix::fs::symlink(&external, staging).unwrap();
    let error = discard_private_install(service.library(), &journal).unwrap_err();
    assert!(!error.details.contains_key("cleanup_hold"));
    assert_eq!(
        fs::read(external.join("sentinel")).unwrap(),
        b"external bytes"
    );
    assert!(
        OperationStore::new(service.library().clone())
            .get(&journal.id)
            .unwrap()
            .is_some()
    );
}

#[test]
fn unproven_builder_retains_tree_and_journal_even_when_staging_is_absent() {
    for exists in [true, false] {
        let (_temporary, service, _operation, journal) = fixture(
            ActivityOperation::Install,
            LifecyclePhase::Preparing,
            Some(false),
        );
        let staging = journal.paths.staging.as_ref().unwrap();
        if !exists {
            fs::remove_dir_all(staging).unwrap();
        }
        let error = discard_private_install(service.library(), &journal).unwrap_err();
        assert_eq!(error.code, ErrorCode::Conflict);
        assert_eq!(
            error.details.get("cleanup_hold").map(String::as_str),
            Some("unproven_process_quiescence")
        );
        assert_eq!(staging.exists(), exists);
        assert_eq!(
            OperationStore::new(service.library().clone())
                .get(&journal.id)
                .unwrap()
                .unwrap()
                .preparation_process_quiesced,
            Some(false)
        );
    }
}

#[test]
fn interrupted_builder_retains_work_for_install_update_and_reconcile() {
    for kind in [
        ActivityOperation::Install,
        ActivityOperation::Update,
        ActivityOperation::Reconcile,
    ] {
        for requested in [false, true] {
            eprintln!("builder retention case: {kind:?}, cancellation requested={requested}");
            let (_temporary, service, operation, journal) =
                fixture(kind, LifecyclePhase::Preparing, Some(false));
            if requested {
                service.request_cancellation(&journal.id).unwrap();
            }
            drop(operation);
            let recovered = PortcoveService::new(service.library().clone()).unwrap();
            assert!(
                journal
                    .paths
                    .staging
                    .as_ref()
                    .unwrap()
                    .join("owned-private")
                    .is_file()
            );
            let retained = OperationStore::new(recovered.library().clone())
                .get(&journal.id)
                .unwrap()
                .unwrap();
            assert_eq!(retained.preparation_process_quiesced, Some(false));
            let activities = recovered.library().activities(1).unwrap();
            assert_eq!(activities[0].operation, kind);
            assert_eq!(activities[0].status, ActivityStatus::Failed);
            assert!(
                activities[0]
                    .message
                    .as_deref()
                    .unwrap()
                    .contains("retained for manual review")
            );
        }
    }
}

#[test]
fn failed_builder_cleanup_pending_stays_retained_across_restarts() {
    let (_temporary, service, operation, journal) = fixture(
        ActivityOperation::Install,
        LifecyclePhase::CleanupPending,
        Some(false),
    );
    drop(operation);
    let first = PortcoveService::new(service.library().clone()).unwrap();
    let store = OperationStore::new(first.library().clone());
    let retained = store.get(&journal.id).unwrap().unwrap();
    assert!(
        journal
            .paths
            .staging
            .as_ref()
            .unwrap()
            .join("owned-private")
            .is_file()
    );
    let message = retained.last_error.unwrap();
    assert!(message.contains("quiescence"));
    let second = PortcoveService::new(first.library().clone()).unwrap();
    let retained_again = OperationStore::new(second.library().clone())
        .get(&journal.id)
        .unwrap()
        .unwrap();
    assert_eq!(retained_again.last_error.as_deref(), Some(message.as_str()));
    assert_eq!(retained_again.preparation_process_quiesced, Some(false));
    assert!(journal.paths.staging.as_ref().unwrap().is_dir());
}

#[test]
fn proven_and_legacy_install_cleanup_keep_their_contract() {
    for quiesced in [None, Some(true)] {
        for kind in [
            ActivityOperation::Install,
            ActivityOperation::Update,
            ActivityOperation::Reconcile,
        ] {
            eprintln!("builder cleanup case: {kind:?}, quiesced={quiesced:?}");
            let (_temporary, service, operation, journal) =
                fixture(kind, LifecyclePhase::Preparing, quiesced);
            service.request_cancellation(&journal.id).unwrap();
            drop(operation);
            let recovered = PortcoveService::new(service.library().clone()).unwrap();
            assert!(!journal.paths.staging.as_ref().unwrap().exists());
            assert!(
                OperationStore::new(recovered.library().clone())
                    .get(&journal.id)
                    .unwrap()
                    .is_none()
            );
            assert_eq!(
                recovered.library().activities(1).unwrap()[0].status,
                ActivityStatus::Cancelled
            );
        }
    }
}

#[test]
fn private_builder_validation_errors_never_become_quiescence_holds() {
    let (temporary, service, _operation, journal) = fixture(
        ActivityOperation::Install,
        LifecyclePhase::Preparing,
        Some(false),
    );
    let external = temporary.path().join("external");
    fs::create_dir(&external).unwrap();
    fs::write(external.join("sentinel"), b"external bytes").unwrap();
    for invalid in ["kind", "uuid", "path", "phase", "file"] {
        let mut changed = journal.clone();
        match invalid {
            "kind" => changed.kind = LifecycleOperationKind::Prepare,
            "uuid" => changed.id = "invalid identity".into(),
            "path" => changed.paths.staging = Some(external.clone()),
            "phase" => changed.phase = LifecyclePhase::Prepared,
            "file" => {
                let staging = changed.paths.staging.as_ref().unwrap();
                fs::remove_dir_all(staging).unwrap();
                fs::write(staging, b"changed object").unwrap();
            }
            _ => unreachable!(),
        }
        let error = discard_private_install(service.library(), &changed).unwrap_err();
        assert!(!error.details.contains_key("cleanup_hold"), "{invalid}");
        assert!(
            OperationStore::new(service.library().clone())
                .get(&journal.id)
                .unwrap()
                .is_some()
        );
        assert_eq!(
            fs::read(external.join("sentinel")).unwrap(),
            b"external bytes"
        );
    }
}
