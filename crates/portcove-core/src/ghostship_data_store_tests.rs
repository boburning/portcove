//! Inert storage and filesystem controls; these do not qualify native consumption.
use super::*;
use crate::{
    ActivityOperation, ActivityTargetKind, LaunchOwnerKind, LaunchSessionOutcome,
    LaunchSessionPhase, Library, ReleaseChannel,
};

pub(crate) fn fixture(library: &Library) -> LegacyDataSeal {
    let activity = library
        .begin_activity(
            ActivityOperation::Launch,
            ActivityTargetKind::Port,
            Some("ghostship"),
        )
        .unwrap();
    let root = library.versions_dir().join("ghostship").join("inert");
    let mut session = LaunchSessionRecord {
        id: activity.id,
        port_id: "ghostship".into(),
        install_id: "inert".into(),
        install_root: root.clone(),
        owner_kind: LaunchOwnerKind::Managed,
        supervisor_pid: 123,
        supervisor_identity: Some("inert:123".into()),
        child_pid: Some(456),
        child_identity: Some("inert:456".into()),
        phase: LaunchSessionPhase::Collecting,
        outcome: None,
        exit_code: None,
        message: None,
        started_at: 1,
        updated_at: 2,
        finished_at: None,
    };
    library.create_launch_session(&session).unwrap();
    session.outcome = Some(LaunchSessionOutcome::Succeeded);
    session.exit_code = Some(0);
    session.finished_at = Some(3);
    LegacyDataSeal {
        format_version: 1,
        session,
        install: InstallRecord {
            id: "inert".into(),
            port_id: "ghostship".into(),
            version: "2.0.0".into(),
            path: root,
            channel: ReleaseChannel::Stable,
            installed_at: 0,
            verified: true,
            staged: false,
            artifact: crate::ArtifactIdentity {
                asset_name: "inert.zip".into(),
                sha256: "a".repeat(64),
                size: 1,
            },
            runtime: None,
            manifest_sha256: "b".repeat(64),
            selected_executable: "inert.exe".into(),
        },
        source: SourceRecord {
            profile_id: "ghostship-source".into(),
            path: library.root().join("inert-original"),
            sha256: "c".repeat(64),
            size: 1,
            storage_sha256: "c".repeat(64),
            storage_size: 1,
            updated_at: 0,
            observed_identity: None,
        },
        receipt_sha256: "d".repeat(64),
        generated_sha256: "e".repeat(64),
        data: AdoptionCopyPlan {
            directories: vec![],
            files: vec![],
            skipped_entries: vec![],
            total_bytes: 0,
        },
    }
}

#[test]
fn ghostship_seal_completion_is_atomic_with_exact_launch_outcome() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path()).unwrap();
    let mut value = fixture(&library);
    let id = value.session.id.clone();
    value.session.child_identity = Some("different:456".into());
    assert!(
        library
            .finish_launch_session_with_legacy_seal(
                &id,
                LaunchSessionOutcome::Succeeded,
                Some(0),
                None,
                Some(&value)
            )
            .is_err()
    );
    assert!(library.active_launch_session(&id).unwrap().is_some());
    assert!(seal(&library.connection().unwrap()).unwrap().is_none());
    value.session.child_identity = Some("inert:456".into());
    library
        .finish_launch_session_with_legacy_seal(
            &id,
            LaunchSessionOutcome::Succeeded,
            Some(0),
            None,
            Some(&value),
        )
        .unwrap();
    assert!(library.active_launch_session(&id).unwrap().is_none());
    assert_eq!(
        seal(&library.connection().unwrap())
            .unwrap()
            .unwrap()
            .session
            .id,
        id
    );
    assert!(
        library
            .finish_launch_session_with_legacy_seal(
                &id,
                LaunchSessionOutcome::Succeeded,
                Some(0),
                None,
                Some(&value)
            )
            .is_err()
    );
}

#[test]
fn ghostship_new_launch_invalidates_previous_consumption_before_any_child() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path()).unwrap();
    let value = fixture(&library);
    library
        .finish_launch_session_with_legacy_seal(
            &value.session.id,
            LaunchSessionOutcome::Succeeded,
            Some(0),
            None,
            Some(&value),
        )
        .unwrap();
    let next = fixture(&library);
    assert!(seal(&library.connection().unwrap()).unwrap().is_none());
    library
        .finish_launch_session(
            &next.session.id,
            LaunchSessionOutcome::Failed,
            Some(1),
            None,
        )
        .unwrap();
    assert!(seal(&library.connection().unwrap()).unwrap().is_none());
}

#[test]
fn ghostship_lifecycle_mutation_invalidates_only_its_own_consumption() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path()).unwrap();
    let value = fixture(&library);
    library
        .finish_launch_session_with_legacy_seal(
            &value.session.id,
            LaunchSessionOutcome::Succeeded,
            Some(0),
            None,
            Some(&value),
        )
        .unwrap();
    let store = crate::operation::OperationStore::new(library.clone());
    let mut other = crate::operation::LifecycleOperation::new(
        "other",
        crate::operation::LifecycleOperationKind::Install,
        "lighthouse",
    );
    store.put(&mut other).unwrap();
    assert!(seal(&library.connection().unwrap()).unwrap().is_some());
    let mut own = crate::operation::LifecycleOperation::new(
        "own",
        crate::operation::LifecycleOperationKind::Install,
        "ghostship",
    );
    store.put(&mut own).unwrap();
    assert!(seal(&library.connection().unwrap()).unwrap().is_none());
}

#[test]
fn ghostship_qualified_tree_preserves_empty_directories_and_refuses_hardlinks() {
    let temporary = tempfile::tempdir().unwrap();
    fs::create_dir(temporary.path().join("empty")).unwrap();
    fs::write(temporary.path().join("settings"), b"current").unwrap();
    let plan = reviewed_data(temporary.path()).unwrap();
    assert_eq!(plan.directories, vec![std::path::PathBuf::from("empty")]);
    assert_eq!(plan.files.len(), 1);
    fs::hard_link(
        temporary.path().join("settings"),
        temporary.path().join("alias"),
    )
    .unwrap();
    assert!(reviewed_data(temporary.path()).is_err());
    assert_eq!(
        fs::read(temporary.path().join("settings")).unwrap(),
        b"current"
    );
}

#[test]
fn ghostship_qualified_tree_refuses_excess_depth() {
    let temporary = tempfile::tempdir().unwrap();
    let deep = (0..26).fold(temporary.path().to_path_buf(), |path, _| path.join("d"));
    fs::create_dir_all(&deep).unwrap();
    assert!(reviewed_data(temporary.path()).is_err());
}

#[test]
fn ghostship_qualified_tree_respects_filesystem_case_capabilities() {
    use std::io::Write;
    let aliases = tempfile::tempdir().unwrap();
    fs::write(aliases.path().join("Data"), b"first").unwrap();
    let first_key = crate::portable_tree::validate_relative_path("Data", false)
        .unwrap()
        .1;
    let second_key = crate::portable_tree::validate_relative_path("data", false)
        .unwrap()
        .1;
    assert_eq!(
        first_key, second_key,
        "portable collision identity is platform independent"
    );
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(aliases.path().join("data"))
    {
        Ok(mut second) => {
            second.write_all(b"second").unwrap();
            drop(second);
            assert_eq!(fs::read_dir(aliases.path()).unwrap().count(), 2);
            assert!(reviewed_data(aliases.path()).is_err());
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            // Default macOS and Windows volumes cannot represent this two-entry
            // fixture. Verify the actual single-entry tree without overwriting it;
            // Linux qualification executes the physical collision refusal above.
            assert_eq!(fs::read_dir(aliases.path()).unwrap().count(), 1);
            assert_eq!(reviewed_data(aliases.path()).unwrap().files.len(), 1);
        }
        Err(error) => panic!("case-capability fixture could not be created: {error}"),
    }
    assert_eq!(fs::read(aliases.path().join("Data")).unwrap(), b"first");
}

#[test]
fn ghostship_ordinary_backup_survives_later_qualification_depth_refusal() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path()).unwrap();
    let mut value = fixture(&library);
    library.register_install(&value.install, true).unwrap();
    library.register_source(&value.source).unwrap();
    let user = library.user_dir("ghostship");
    fs::create_dir_all(&user).unwrap();
    fs::write(user.join("settings"), b"preserve ordinary data").unwrap();
    value.data = reviewed_data(&user).unwrap();
    library
        .finish_launch_session_with_legacy_seal(
            &value.session.id,
            LaunchSessionOutcome::Succeeded,
            Some(0),
            None,
            Some(&value),
        )
        .unwrap();
    let deep = (0..26).fold(user.clone(), |path, _| path.join("d"));
    fs::create_dir_all(&deep).unwrap();
    let service = crate::PortcoveService::new(library.clone()).unwrap();
    let backup = service.create_backup("ghostship").unwrap();
    assert_eq!(
        fs::read(backup.path.join("data/settings")).unwrap(),
        b"preserve ordinary data"
    );
    assert!(backup.path.join("backup.json").is_file());
    assert!(
        backup
            .path
            .join("data")
            .join(deep.strip_prefix(&user).unwrap())
            .is_dir()
    );
    let count: i64 = library
        .connection()
        .unwrap()
        .query_row(
            "SELECT count(*) FROM ghostship_qualified_backups",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn ghostship_pending_probe_ignores_malformed_unrelated_journals() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path()).unwrap();
    let store = crate::operation::OperationStore::new(library.clone());
    let mut other = crate::operation::LifecycleOperation::new(
        "other",
        crate::operation::LifecycleOperationKind::Install,
        "lighthouse",
    );
    store.put(&mut other).unwrap();
    let connection = library.connection().unwrap();
    connection.execute("UPDATE lifecycle_operations SET kind='unreadable-other-kind', install_json='{' WHERE id='other'", []).unwrap();
    assert!(store.all().is_err());
    assert!(!pending_legacy_work(&connection).unwrap());
    connection
        .execute(
            "UPDATE lifecycle_operations SET port_id='ghostship' WHERE id='other'",
            [],
        )
        .unwrap();
    assert!(pending_legacy_work(&connection).unwrap());
}

#[test]
fn ghostship_consumption_tree_refusal_allows_terminal_success_without_seal() {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path()).unwrap();
    let value = fixture(&library);
    let user = library.user_dir("ghostship");
    let deep = (0..26).fold(user.clone(), |path, _| path.join("d"));
    fs::create_dir_all(&deep).unwrap();
    let optional = consumption_data(&user).unwrap().map(|data| LegacyDataSeal {
        data,
        ..value.clone()
    });
    assert!(optional.is_none());
    library
        .finish_launch_session_with_legacy_seal(
            &value.session.id,
            LaunchSessionOutcome::Succeeded,
            Some(0),
            None,
            optional.as_ref(),
        )
        .unwrap();
    let connection = library.connection().unwrap();
    let outcome: (String, i32) = connection
        .query_row(
            "SELECT outcome,exit_code FROM launch_sessions WHERE id=?1",
            [&value.session.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(outcome, ("succeeded".into(), 0));
    assert!(seal(&connection).unwrap().is_none());
    assert!(deep.is_dir());
    // Missing/unreadable storage is distinct from a supported-shape refusal.
    assert!(consumption_data(&user.join("missing-storage")).is_err());
}
