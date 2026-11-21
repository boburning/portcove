// Windows service lifecycle fixtures. ZIP players are inert and never executed.
struct CarryServiceFixture {
    _temporary: tempfile::TempDir,
    library: Library,
    service: PortcoveService,
    active: InstallRecord,
    target: InstallRecord,
}

async fn carry_service_fixture() -> CarryServiceFixture {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let server = Server::new();
    let provider = Arc::new(Provider(Mutex::new(server.release("v1", 1))));
    let service = build_service(library.clone(), provider.clone());
    let active = service
        .install("portable-fixture", None, None, None, true, |_| {})
        .await
        .unwrap();
    *provider.0.lock().unwrap() = server.release("v2", 2);
    let target = service
        .install("portable-fixture", None, None, None, false, |_| {})
        .await
        .unwrap();
    CarryServiceFixture {
        _temporary: temporary,
        library,
        service,
        active,
        target,
    }
}

#[tokio::test]
async fn activation_keeps_a_future_format_target_row_and_its_source_file_separate() {
    let fixture = carry_service_fixture().await;
    let source = b"future-format player data";
    fs::write(fixture.active.path.join("future.txt"), source).unwrap();
    fs::write(fixture.active.path.join("notes.txt"), b"ordinary data").unwrap();
    let digest = crate::signed_catalog::digest(source);
    let connection = fixture.library.connection().unwrap();
    connection.execute(
        "INSERT INTO carried_files (install_id,path,state,sha256,lineage,format) VALUES (?1,'future.txt','present',?2,?3,?4)",
        rusqlite::params![fixture.target.id, digest, serde_json::to_string(&vec![digest.clone()]).unwrap(), crate::carry_ledger::ROW_FORMAT + 1],
    ).unwrap();
    let saved_row = || {
        connection.query_row(
        "SELECT state,sha256,lineage,format FROM carried_files WHERE install_id=?1 AND path='future.txt'",
        [&fixture.target.id], |row| Ok((row.get::<_, String>(0)?,row.get::<_, String>(1)?,row.get::<_, String>(2)?,row.get::<_, i64>(3)?)),
    ).unwrap()
    };
    let before = saved_row();
    assert_eq!(
        fixture
            .service
            .activate_staged("portable-fixture")
            .unwrap()
            .id,
        fixture.target.id
    );
    assert_eq!(
        saved_row(),
        before,
        "future-format ownership is never rewritten"
    );
    assert!(!fixture.target.path.join("future.txt").exists());
    assert_eq!(
        fs::read(fixture.active.path.join("future.txt")).unwrap(),
        source
    );
    assert_eq!(
        fs::read(fixture.target.path.join("notes.txt")).unwrap(),
        b"ordinary data"
    );
    let outcome = fixture
        .service
        .status("portable-fixture")
        .unwrap()
        .carried_files
        .unwrap();
    assert_eq!(outcome.outcome.kept_separately, ["future.txt"]);
    assert_eq!(outcome.outcome.carried, ["notes.txt"]);
}

#[tokio::test]
async fn activation_recovery_replans_pending_replacement_and_sweeps_stale_temporary_files() {
    let fixture = carry_service_fixture().await;
    let old = b"earlier settings";
    let new = b"newer player settings";
    let old_digest = crate::signed_catalog::digest(old);
    let new_digest = crate::signed_catalog::digest(new);
    fs::write(fixture.active.path.join("notes.txt"), new).unwrap();
    fs::write(fixture.target.path.join("notes.txt"), old).unwrap();
    fs::write(
        fixture.target.path.join(".portcove-carry-interrupted"),
        b"incomplete staging",
    )
    .unwrap();
    let source_row = crate::carry_plan::CarryRow::present(
        &new_digest,
        vec![old_digest.clone(), new_digest.clone()],
    );
    let replaced = crate::carry_plan::CarryRow::present(&old_digest, vec![old_digest.clone()]);
    // Synthetic pre-publication interruption state: this is not a crash-run receipt.
    let pending = crate::carry_plan::CarryRow {
        state: crate::carry_plan::RowState::Pending {
            source_install_id: fixture.active.id.clone(),
        },
        sha256: new_digest.clone(),
        lineage: source_row.lineage.clone(),
    };
    {
        let mut connection = fixture.library.connection().unwrap();
        let transaction = connection.transaction().unwrap();
        assert!(
            crate::carry_ledger::put(
                &transaction,
                &fixture.active.id,
                "notes.txt",
                &source_row,
                None
            )
            .unwrap()
        );
        assert!(
            crate::carry_ledger::put(
                &transaction,
                &fixture.target.id,
                "notes.txt",
                &pending,
                Some(&replaced)
            )
            .unwrap()
        );
        transaction.commit().unwrap();
    }
    let store = OperationStore::new(fixture.library.clone());
    let mut operation = LifecycleOperation::new(
        "carry-interrupted-activation",
        LifecycleOperationKind::Activate,
        "portable-fixture",
    );
    operation.install = Some(fixture.target.clone());
    store.put(&mut operation).unwrap();
    fixture.service.recover_pending_operations().unwrap();
    assert!(store.get(&operation.id).unwrap().is_none());
    assert_eq!(
        fixture
            .library
            .status("portable-fixture", ReleaseChannel::Stable)
            .unwrap()
            .active
            .unwrap()
            .id,
        fixture.target.id
    );
    assert_eq!(
        fs::read(fixture.active.path.join("notes.txt")).unwrap(),
        new
    );
    assert_eq!(
        fs::read(fixture.target.path.join("notes.txt")).unwrap(),
        new
    );
    assert!(
        !fixture
            .target
            .path
            .join(".portcove-carry-interrupted")
            .exists()
    );
    let rows =
        crate::carry_ledger::load(&fixture.library.connection().unwrap(), &fixture.target.id)
            .unwrap();
    assert_eq!(
        rows["notes.txt"].row.state,
        crate::carry_plan::RowState::Present
    );
    assert_eq!(rows["notes.txt"].row.sha256, new_digest);
    assert!(rows["notes.txt"].replaces.is_none());
    assert_eq!(crate::carry_step::sweep(&fixture.target.path).unwrap(), 0);
}

#[tokio::test]
async fn windows_locked_carry_target_holds_activation_then_retry_keeps_both_copies() {
    use std::os::windows::fs::OpenOptionsExt;
    let fixture = carry_service_fixture().await;
    let source = b"active player copy";
    let target = b"different target copy";
    fs::write(fixture.active.path.join("notes.txt"), source).unwrap();
    fs::write(fixture.target.path.join("notes.txt"), target).unwrap();
    let held = fs::File::options()
        .read(true)
        .share_mode(0)
        .open(fixture.target.path.join("notes.txt"))
        .unwrap();
    // Full activation snapshots retained data first and can encounter this
    // lock before carry. Exercise carry's exact refusal under its caller's
    // required port lock, then verify the complete public hold/retry outcome.
    {
        let _operation = fixture
            .library
            .try_lock_port("portable-fixture", "carry-lock-fixture")
            .unwrap();
        let error = fixture
            .service
            .carry_unknown_files(&fixture.active, &fixture.target)
            .unwrap_err();
        assert_eq!(
            error
                .details
                .get("carried_file_unreadable")
                .map(String::as_str),
            Some("notes.txt"),
            "{error:?}"
        );
    }
    let error = fixture
        .service
        .activate_staged("portable-fixture")
        .unwrap_err();
    eprintln!(
        "public activation lock refusal: {:?}; {}",
        error.code,
        error.message.chars().take(512).collect::<String>()
    );
    let status = fixture
        .library
        .status("portable-fixture", ReleaseChannel::Stable)
        .unwrap();
    assert_eq!(status.active.unwrap().id, fixture.active.id);
    assert_eq!(status.staged.unwrap().id, fixture.target.id);
    assert_eq!(
        fs::read(fixture.active.path.join("notes.txt")).unwrap(),
        source
    );
    assert!(
        crate::carry_ledger::load(&fixture.library.connection().unwrap(), &fixture.target.id)
            .unwrap()
            .is_empty()
    );
    drop(held);
    assert_eq!(
        fs::read(fixture.target.path.join("notes.txt")).unwrap(),
        target
    );
    assert_eq!(
        fixture
            .service
            .activate_staged("portable-fixture")
            .unwrap()
            .id,
        fixture.target.id
    );
    assert_eq!(
        fs::read(fixture.active.path.join("notes.txt")).unwrap(),
        source
    );
    assert_eq!(
        fs::read(fixture.target.path.join("notes.txt")).unwrap(),
        target
    );
    let outcome = fixture
        .service
        .status("portable-fixture")
        .unwrap()
        .carried_files
        .unwrap();
    assert_eq!(outcome.outcome.kept_separately, ["notes.txt"]);
    assert!(outcome.outcome.carried.is_empty());
}
