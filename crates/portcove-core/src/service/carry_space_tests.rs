// Deterministic Windows Core fixtures; ZIP players are inert and never run.
async fn low_space_fixture() -> (
    tempfile::TempDir,
    PortcoveService,
    InstallRecord,
    InstallRecord,
) {
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let server = Server::new();
    let provider = Arc::new(Provider(Mutex::new(server.release("v1", 1))));
    let service = build_service(library, provider.clone());
    let active = service
        .install("portable-fixture", None, None, None, true, |_| {})
        .await
        .unwrap();
    *provider.0.lock().unwrap() = server.release("v2", 2);
    let target = service
        .install("portable-fixture", None, None, None, false, |_| {})
        .await
        .unwrap();
    (temporary, service, active, target)
}

#[tokio::test]
async fn low_space_carry_restores_displaced_rows_and_records_no_copies() {
    assert_space_carry_restoration(false).await;
}

#[tokio::test]
async fn staging_exhaustion_restores_rows_and_records_unknown_available_space() {
    assert_space_carry_restoration(true).await;
}

async fn assert_space_carry_restoration(during_staging: bool) {
    let (_temporary, service, active, target) = low_space_fixture().await;
    let old = b"earlier player settings";
    let new = b"updated player settings";
    let old_digest = crate::signed_catalog::digest(old);
    let new_digest = crate::signed_catalog::digest(new);
    fs::write(active.path.join("notes.txt"), new).unwrap();
    fs::write(target.path.join("notes.txt"), old).unwrap();
    fs::create_dir_all(active.path.join("nested")).unwrap();
    fs::write(active.path.join("nested/fresh.txt"), b"fresh data").unwrap();
    let source_row = crate::carry_plan::CarryRow::present(
        &new_digest,
        vec![old_digest.clone(), new_digest.clone()],
    );
    let target_row = crate::carry_plan::CarryRow::present(&old_digest, vec![old_digest.clone()]);
    {
        let mut connection = service.library.connection().unwrap();
        let transaction = connection.transaction().unwrap();
        for (install, row) in [(&active, &source_row), (&target, &target_row)] {
            assert!(
                crate::carry_ledger::put(&transaction, &install.id, "notes.txt", row, None)
                    .unwrap()
            );
        }
        transaction.commit().unwrap();
    }
    let before = [&active, &target].map(|install| {
        crate::carry_ledger::load(&service.library.connection().unwrap(), &install.id).unwrap()
    });
    let _guard = service
        .library
        .try_lock_port("portable-fixture", "low-space-fixture")
        .unwrap();
    let writes = std::cell::Cell::new(0);
    let writer = |output: &mut fs::File, bytes: &[u8]| {
        writes.set(writes.get() + 1);
        if writes.get() == 2 {
            crate::carry_step::write_staging(output, &bytes[..1])?;
            return Err(std::io::ErrorKind::StorageFull.into());
        }
        crate::carry_step::write_staging(output, bytes)
    };
    let outcome = service
        .carry_unknown_files_with_staging_writer(
            &active,
            &target,
            &|root| {
                assert_eq!(
                    fs::canonicalize(root).unwrap(),
                    fs::canonicalize(&target.path).unwrap()
                );
                Ok((
                    if during_staging { u64::MAX } else { 0 },
                    10 * 1024 * 1024 * 1024,
                ))
            },
            during_staging.then_some(&writer),
        )
        .unwrap()
        .unwrap();
    assert_eq!(writes.get(), if during_staging { 2 } else { 0 });
    assert!(outcome.insufficient_space);
    assert_eq!(outcome.not_carried_count, Some(2));
    assert_eq!(outcome.available_bytes, (!during_staging).then_some(0));
    assert!(outcome.required_bytes.unwrap() >= crate::carry_step::RESERVE_BYTES);
    assert!(outcome.carried.is_empty());
    assert!(outcome.removed.is_empty());
    assert_eq!(fs::read(active.path.join("notes.txt")).unwrap(), new);
    assert_eq!(fs::read(target.path.join("notes.txt")).unwrap(), old);
    assert_eq!(
        fs::read(active.path.join("nested/fresh.txt")).unwrap(),
        b"fresh data"
    );
    assert!(!target.path.join("nested").exists());
    let after = [&active, &target].map(|install| {
        crate::carry_ledger::load(&service.library.connection().unwrap(), &install.id).unwrap()
    });
    assert_eq!(
        before, after,
        "new pending rows vanish and displaced rows return unchanged"
    );
    assert!(!fs::read_dir(&target.path).unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(crate::carry_step::STAGING_PREFIX)
    }));
    let connection = service.library.connection().unwrap();
    let (from, to, recorded) = crate::carry_ledger::outcome(&connection, "portable-fixture")
        .unwrap()
        .unwrap();
    assert_eq!(from, active.id);
    assert_eq!(to, target.id);
    assert_eq!(recorded["insufficient_space"], true);
    assert_eq!(recorded["not_carried_count"], 2);
    assert_eq!(recorded["required_bytes"], outcome.required_bytes.unwrap());
    assert_eq!(
        recorded
            .get("available_bytes")
            .and_then(serde_json::Value::as_u64),
        outcome.available_bytes
    );
    if during_staging {
        assert!(recorded.get("available_bytes").is_none());
    }
    assert_eq!(
        service
            .status("portable-fixture")
            .unwrap()
            .active
            .unwrap()
            .id,
        active.id
    );
}

#[tokio::test]
async fn low_space_after_partial_publication_keeps_the_switch_on_hold() {
    assert_partial_carry_space_hold(false).await;
}

#[tokio::test]
async fn staging_exhaustion_after_partial_publication_keeps_the_switch_on_hold() {
    assert_partial_carry_space_hold(true).await;
}

async fn assert_partial_carry_space_hold(during_staging: bool) {
    let (_temporary, service, active, target) = low_space_fixture().await;
    let placed = b"already published player data";
    let waiting = b"not yet published player data";
    fs::write(active.path.join("placed.txt"), placed).unwrap();
    fs::write(target.path.join("placed.txt"), placed).unwrap();
    fs::write(active.path.join("waiting.txt"), waiting).unwrap();
    let digest = crate::signed_catalog::digest(placed);
    let pending = crate::carry_plan::CarryRow {
        state: crate::carry_plan::RowState::Pending {
            source_install_id: active.id.clone(),
        },
        sha256: digest.clone(),
        lineage: vec![digest],
    };
    {
        let mut connection = service.library.connection().unwrap();
        let transaction = connection.transaction().unwrap();
        assert!(
            crate::carry_ledger::put(&transaction, &target.id, "placed.txt", &pending, None)
                .unwrap()
        );
        transaction.commit().unwrap();
    }
    let before =
        crate::carry_ledger::load(&service.library.connection().unwrap(), &target.id).unwrap();
    let _guard = service
        .library
        .try_lock_port("portable-fixture", "low-space-partial-fixture")
        .unwrap();
    let writes = std::cell::Cell::new(0);
    let writer = |output: &mut fs::File, bytes: &[u8]| {
        writes.set(writes.get() + 1);
        crate::carry_step::write_staging(output, &bytes[..1])?;
        Err(std::io::ErrorKind::StorageFull.into())
    };
    let error = service
        .carry_unknown_files_with_staging_writer(
            &active,
            &target,
            &|_| {
                Ok((
                    if during_staging { u64::MAX } else { 0 },
                    10 * 1024 * 1024 * 1024,
                ))
            },
            during_staging.then_some(&writer),
        )
        .unwrap_err();
    assert_eq!(writes.get(), u32::from(during_staging));
    assert_eq!(
        error.details.get("available_bytes").map(String::as_str),
        (!during_staging).then_some("0")
    );
    assert!(!fs::read_dir(&target.path).unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(crate::carry_step::STAGING_PREFIX)
    }));
    assert!(
        error
            .details
            .get("required_bytes")
            .unwrap()
            .parse::<u64>()
            .unwrap()
            >= crate::carry_step::RESERVE_BYTES
    );
    assert_eq!(fs::read(active.path.join("placed.txt")).unwrap(), placed);
    assert_eq!(fs::read(target.path.join("placed.txt")).unwrap(), placed);
    assert_eq!(fs::read(active.path.join("waiting.txt")).unwrap(), waiting);
    assert!(!target.path.join("waiting.txt").exists());
    assert_eq!(
        before,
        crate::carry_ledger::load(&service.library.connection().unwrap(), &target.id).unwrap()
    );
    assert!(
        crate::carry_ledger::outcome(&service.library.connection().unwrap(), "portable-fixture")
            .unwrap()
            .is_none()
    );
    assert_eq!(
        service
            .status("portable-fixture")
            .unwrap()
            .active
            .unwrap()
            .id,
        active.id
    );
}
