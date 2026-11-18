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
    let relative = retained
        .path
        .strip_prefix(retained_library.versions_dir())
        .unwrap();
    let retained_path = library.versions_dir().join(relative);
    drop(historical);
    drop(retained_library);
    fs::create_dir_all(retained_path.parent().unwrap()).unwrap();
    fs::rename(&retained.path, &retained_path).unwrap();
    retained.path = retained_path;
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
}
