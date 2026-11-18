// Windows Core fixtures. Inert ZIP players are never executed.
#[tokio::test]
async fn carry_respects_other_retained_declarations_for_new_files_and_recorded_removals() {
    const ID: &str = "portable-fixture";
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let server = Server::new();
    let provider = Arc::new(Provider(Mutex::new(server.release("v1", 1))));
    let mut service = build_service(library.clone(), provider.clone());
    let active = service
        .install(ID, None, None, None, true, |_| {})
        .await
        .unwrap();
    *provider.0.lock().unwrap() = server.release("v2", 2);
    let target = service
        .install(ID, None, None, None, false, |_| {})
        .await
        .unwrap();

    let mut declared = serde_json::to_value(catalog().authoritative_document()).unwrap();
    declared["ports"][0]["persistent_paths"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!("legacy"));
    declared["ports"][0]["persistent_file_patterns"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!({"prefix":"hold_", "suffix":".txt"}));
    // Create this historical contract independently. Requesting it as a live
    // transition would correctly refuse the changed persistence declarations.
    let retained_library = Library::open(temporary.path().join("historical-library")).unwrap();
    let mut historical = build_service(retained_library.clone(), provider.clone());
    historical.replace_catalog_for_test(Catalog::from_json(&declared.to_string()).unwrap());
    *provider.0.lock().unwrap() = server.release("v3", 3);
    let mut retained = historical
        .install(ID, None, None, None, true, |_| {})
        .await
        .unwrap();
    // Published Windows paths can carry the verbatim prefix while the Library
    // was opened with an ordinary spelling. Compare filesystem coordinates.
    let historical_root = fs::canonicalize(&retained.path).unwrap();
    let historical_versions = fs::canonicalize(retained_library.versions_dir()).unwrap();
    let relative = historical_root.strip_prefix(&historical_versions).unwrap();
    let retained_path = library.versions_dir().join(relative);
    drop(historical);
    drop(retained_library);
    fs::create_dir_all(retained_path.parent().unwrap()).unwrap();
    fs::rename(&historical_root, &retained_path).unwrap();
    retained.path = fs::canonicalize(&retained_path).unwrap();
    library.register_install(&retained, false).unwrap();
    let mut current = serde_json::to_value(catalog().authoritative_document()).unwrap();
    current["ports"][0]["persistent_paths"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!("current-only"));
    current["ports"][0]["persistent_file_patterns"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!({"prefix":"now_", "suffix":".txt"}));
    service.replace_catalog_for_test(Catalog::from_json(&current.to_string()).unwrap());
    assert_ne!(retained.id, active.id);
    assert_ne!(retained.id, target.id);
    assert_eq!(library.installs_for_port(ID).unwrap().len(), 3);

    fs::create_dir_all(active.path.join("legacy")).unwrap();
    fs::write(active.path.join("legacy/fresh.txt"), b"new player data").unwrap();
    fs::write(
        active.path.join("hold_profile.txt"),
        b"declared by retained pattern",
    )
    .unwrap();
    fs::write(active.path.join("notes.txt"), b"ordinary unknown data").unwrap();
    fs::create_dir_all(active.path.join("current-only")).unwrap();
    fs::write(
        active.path.join("current-only/fresh.txt"),
        b"current declared path",
    )
    .unwrap();
    fs::write(
        active.path.join("now_profile.txt"),
        b"current declared pattern",
    )
    .unwrap();
    fs::create_dir_all(target.path.join("legacy")).unwrap();
    let old = b"recorded player data";
    fs::write(target.path.join("legacy/removed.txt"), old).unwrap();
    // Model a valid prior carry whose source copy the player later deleted.
    // These are synthetic ledger facts, not an observed native save history.
    let digest = crate::signed_catalog::digest(old);
    let row = crate::carry_plan::CarryRow::present(&digest, vec![digest.clone()]);
    {
        let mut connection = library.connection().unwrap();
        let transaction = connection.transaction().unwrap();
        for install in [&active, &target] {
            assert!(
                crate::carry_ledger::put(
                    &transaction,
                    &install.id,
                    "legacy/removed.txt",
                    &row,
                    None
                )
                .unwrap()
            );
        }
        transaction.commit().unwrap();
    }
    let before = [&active, &target].map(|install| crate::carry_ledger::load(&library.connection().unwrap(), &install.id).unwrap()["legacy/removed.txt"].clone());
    let outcome = service
        .carry_unknown_files(&active, &target)
        .unwrap()
        .unwrap();
    assert_eq!(
        fs::read(target.path.join("notes.txt")).unwrap(),
        b"ordinary unknown data"
    );
    assert_eq!(outcome.carried, ["notes.txt"]);
    assert!(outcome.removed.is_empty());
    assert!(!target.path.join("legacy/fresh.txt").exists());
    assert!(!target.path.join("hold_profile.txt").exists());
    assert!(!target.path.join("current-only/fresh.txt").exists());
    assert!(!target.path.join("now_profile.txt").exists());
    assert_eq!(
        fs::read(target.path.join("legacy/removed.txt")).unwrap(),
        old
    );
    assert_eq!(
        fs::read(active.path.join("legacy/fresh.txt")).unwrap(),
        b"new player data"
    );
    assert_eq!(
        fs::read(active.path.join("hold_profile.txt")).unwrap(),
        b"declared by retained pattern"
    );
    let after = [&active, &target].map(|install| crate::carry_ledger::load(&library.connection().unwrap(), &install.id).unwrap()["legacy/removed.txt"].clone());
    assert_eq!(before, after, "excluded lineage stays frozen");
    assert_eq!(service.status(ID).unwrap().active.unwrap().id, active.id);

    // A current non-owning registration route has no executable hints. It
    // must not impose new execution qualification on this retained pair.
    let mut document = serde_json::to_value(catalog().authoritative_document()).unwrap();
    document["ports"][0]["adapter"] = serde_json::json!("staged-source-portable");
    document["ports"][0]["channels"] = serde_json::json!(["stable"]);
    document["ports"][0]["executable_hints"] = serde_json::json!({});
    document["ports"][0]["persistent_paths"] = serde_json::json!([]);
    document["ports"][0]["persistent_file_patterns"] = serde_json::json!([]);
    document["ports"][0]["release"] = serde_json::json!({
        "provider": "user-prepared", "repository": "example/game",
        "user_prepared": {"windows-x86-64": {
            "trust": "user-selected", "version": "user-managed",
            "archive_name": "", "archive_size": 0, "archive_sha256": "",
            "immutable_tree_sha256": "", "executable": "", "mutable_paths": []
        }}
    });
    service.replace_catalog_for_test(Catalog::from_json(&document.to_string()).unwrap());
    assert!(
        service
            .catalog
            .port(ID)
            .unwrap()
            .executable_hints
            .is_empty()
    );
    fs::remove_file(active.path.join("current-only/fresh.txt")).unwrap();
    fs::remove_file(active.path.join("now_profile.txt")).unwrap();
    fs::write(
        active.path.join("external-notes.txt"),
        b"retained route still works",
    )
    .unwrap();
    let outcome = service
        .carry_unknown_files(&active, &target)
        .unwrap()
        .unwrap();
    assert_eq!(outcome.carried, ["external-notes.txt"]);
    assert_eq!(
        fs::read(target.path.join("external-notes.txt")).unwrap(),
        b"retained route still works"
    );
    assert_eq!(
        fs::read(target.path.join("legacy/removed.txt")).unwrap(),
        old
    );
}

#[tokio::test]
async fn carry_excludes_active_only_generated_metadata_even_with_recorded_lineage() {
    const ID: &str = "portable-fixture";
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let server = Server::new();
    let provider = Arc::new(Provider(Mutex::new(server.release("v1", 1))));
    let mut service = build_service(library.clone(), provider.clone());
    let mut old = serde_json::to_value(catalog().authoritative_document()).unwrap();
    old["ports"][0]["portable_marker"] = serde_json::json!(true);
    service.replace_catalog_for_test(Catalog::from_json(&old.to_string()).unwrap());
    let active = service
        .install(ID, None, None, None, true, |_| {})
        .await
        .unwrap();
    // Native archive acquisition does not run launch preparation. Create the
    // marker through Core's actual preparation path, without executing a player.
    let prepared = service.prepare_launch(ID, None).unwrap();
    assert_eq!(
        prepared.executable,
        active.path.join(&active.selected_executable)
    );
    assert_eq!(fs::read(active.path.join("portable.txt")).unwrap(), b"");

    // Admit the different historical definition independently. This is a carry
    // fixture over two retained contracts, not proof of a permitted live update.
    let target_library = Library::open(temporary.path().join("independent-target")).unwrap();
    let target_service = build_service(target_library.clone(), provider.clone());
    *provider.0.lock().unwrap() = server.release("v2", 2);
    let mut target = target_service
        .install(ID, None, None, None, true, |_| {})
        .await
        .unwrap();
    assert!(!target.path.join("portable.txt").exists());
    let target_root = fs::canonicalize(&target.path).unwrap();
    let target_versions = fs::canonicalize(target_library.versions_dir()).unwrap();
    let destination = library
        .versions_dir()
        .join(target_root.strip_prefix(&target_versions).unwrap());
    drop(target_service);
    drop(target_library);
    fs::create_dir_all(destination.parent().unwrap()).unwrap();
    fs::rename(target_root, &destination).unwrap();
    target.path = fs::canonicalize(destination).unwrap();
    library.register_install(&target, false).unwrap();
    service.replace_catalog_for_test(catalog());

    let previous = b"earlier synthetic carry of generated metadata";
    fs::write(target.path.join("portable.txt"), previous).unwrap();
    fs::write(active.path.join("notes.txt"), b"ordinary player file").unwrap();
    let digest = crate::signed_catalog::digest(previous);
    let row = crate::carry_plan::CarryRow::present(&digest, vec![digest.clone()]);
    let mut connection = library.connection().unwrap();
    let transaction = connection.transaction().unwrap();
    for install in [&active, &target] {
        assert!(
            crate::carry_ledger::put(&transaction, &install.id, "portable.txt", &row, None)
                .unwrap()
        );
    }
    transaction.commit().unwrap();
    drop(connection);
    let before = [&active, &target].map(|install| crate::carry_ledger::load(&library.connection().unwrap(), &install.id).unwrap()["portable.txt"].clone());
    let _guard = library
        .try_lock_port(ID, "active-generated-metadata-fixture")
        .unwrap();
    let outcome = service
        .carry_unknown_files(&active, &target)
        .unwrap()
        .unwrap();
    assert_eq!(outcome.carried, ["notes.txt"]);
    assert!(outcome.removed.is_empty());
    assert_eq!(fs::read(active.path.join("portable.txt")).unwrap(), b"");
    assert_eq!(
        fs::read(target.path.join("portable.txt")).unwrap(),
        previous
    );
    assert_eq!(
        fs::read(target.path.join("notes.txt")).unwrap(),
        b"ordinary player file"
    );
    let after = [&active, &target].map(|install| crate::carry_ledger::load(&library.connection().unwrap(), &install.id).unwrap()["portable.txt"].clone());
    assert_eq!(before, after, "excluded metadata lineage stays frozen");
    assert_eq!(service.status(ID).unwrap().active.unwrap().id, active.id);
}

#[tokio::test]
async fn carry_runtime_mutability_uses_working_directory_not_persistence_root() {
    const ID: &str = "portable-fixture";
    let temporary = tempfile::tempdir().unwrap();
    let library = Library::open(temporary.path().join("library")).unwrap();
    let server = Server::new();
    let provider = Arc::new(Provider(Mutex::new(server.release_in_folder(
        "v1",
        1,
        "",
        "runtime/game.exe",
    ))));
    let mut service = build_service(library.clone(), provider.clone());
    let mut document = serde_json::to_value(catalog().authoritative_document()).unwrap();
    document["ports"][0]["adapter"] = serde_json::json!("staged-source-portable");
    document["ports"][0]["launch_from_install_root"] = serde_json::json!(true);
    document["ports"][0]["runtime_subdirectory"] = serde_json::json!("runtime");
    document["ports"][0]["runtime_mutable_paths"] = serde_json::json!(["cache"]);
    document["ports"][0]["runtime_mutable_file_patterns"] =
        serde_json::json!([{"prefix":"dyn_", "suffix":".tmp"}]);
    service.replace_catalog_for_test(Catalog::from_json(&document.to_string()).unwrap());
    assert!(crate::persistence::ready_staged_archive(
        service.catalog.port(ID).unwrap()
    ));
    let active = service
        .install(ID, None, None, None, true, |_| {})
        .await
        .unwrap();
    *provider.0.lock().unwrap() = server.release_in_folder("v2", 2, "", "runtime/game.exe");
    let target = service
        .install(ID, None, None, None, false, |_| {})
        .await
        .unwrap();
    assert_eq!(
        active.selected_executable,
        std::path::Path::new("runtime/game.exe")
    );
    for (path, bytes) in [
        ("runtime/cache/state.txt", b"runtime settings".as_slice()),
        ("runtime/dyn_state.tmp", b"runtime scratch"),
        ("cache/state.txt", b"ordinary root file"),
        ("dyn_state.tmp", b"ordinary root sibling"),
    ] {
        let path = active.path.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }
    let old = b"recorded runtime data whose source was deleted";
    fs::write(target.path.join("runtime/dyn_deleted.tmp"), old).unwrap();
    let digest = crate::signed_catalog::digest(old);
    let row = crate::carry_plan::CarryRow::present(&digest, vec![digest.clone()]);
    let mut connection = library.connection().unwrap();
    let transaction = connection.transaction().unwrap();
    for install in [&active, &target] {
        assert!(
            crate::carry_ledger::put(
                &transaction,
                &install.id,
                "runtime/dyn_deleted.tmp",
                &row,
                None
            )
            .unwrap()
        );
    }
    transaction.commit().unwrap();
    drop(connection);
    let before = [&active, &target].map(|install| crate::carry_ledger::load(&library.connection().unwrap(), &install.id).unwrap()["runtime/dyn_deleted.tmp"].clone());
    let _guard = library
        .try_lock_port(ID, "runtime-coordinate-fixture")
        .unwrap();
    let outcome = service
        .carry_unknown_files(&active, &target)
        .unwrap()
        .unwrap();
    assert_eq!(outcome.carried, ["cache/state.txt", "dyn_state.tmp"]);
    assert!(outcome.removed.is_empty());
    assert!(!target.path.join("runtime/cache/state.txt").exists());
    assert!(!target.path.join("runtime/dyn_state.tmp").exists());
    assert_eq!(
        fs::read(target.path.join("cache/state.txt")).unwrap(),
        b"ordinary root file"
    );
    assert_eq!(
        fs::read(target.path.join("dyn_state.tmp")).unwrap(),
        b"ordinary root sibling"
    );
    assert_eq!(
        fs::read(target.path.join("runtime/dyn_deleted.tmp")).unwrap(),
        old
    );
    let after = [&active, &target].map(|install| crate::carry_ledger::load(&library.connection().unwrap(), &install.id).unwrap()["runtime/dyn_deleted.tmp"].clone());
    assert_eq!(before, after);
    assert_eq!(service.status(ID).unwrap().active.unwrap().id, active.id);
}
