use super::*;
#[test]
fn shared_review_refuses_unknown_or_inconsistent_fallback_semantics() {
    let smb = serde_json::json!({
        "binding":{"contract":"smb1r-1.1-stable-windows", "account_sid_sha256":"a".repeat(64), "path":"C:\\Roaming\\SMB1R"},
        "present":false, "local_fallback_path":null, "local_fallback_present":false
    });
    let review: crate::SharedPreferencesReview = serde_json::from_value(smb.clone()).unwrap();
    assert!(
        review
            .write_scope_disclosure()
            .unwrap()
            .contains("shared directory")
    );
    for patch in [
        serde_json::json!({"local_fallback_path":"C:\\unexpected"}),
        serde_json::json!({"local_fallback_present":true}),
        serde_json::json!({"binding":{"contract":"arbitrary-path", "account_sid_sha256":"a".repeat(64), "path":"C:\\Roaming"}}),
    ] {
        let mut value = smb.clone();
        value
            .as_object_mut()
            .unwrap()
            .extend(patch.as_object().unwrap().clone());
        assert!(serde_json::from_value::<crate::SharedPreferencesReview>(value).is_err());
    }
    let mut regaiden = smb;
    regaiden["binding"]["contract"] = "regaiden041-windows".into();
    assert!(serde_json::from_value::<crate::SharedPreferencesReview>(regaiden.clone()).is_err());
    regaiden["local_fallback_path"] = "C:\\Runtime\\runtime_prefs.ini".into();
    let parsed: crate::SharedPreferencesReview = serde_json::from_value(regaiden.clone()).unwrap();
    assert_eq!(serde_json::to_value(parsed).unwrap(), regaiden);
}
#[test]
fn narrow_windows_paths_refuse_encoding_control_and_max_path_boundaries() {
    for path in ["", "C:\\caf\u{e9}", "C:\\game\nfile", "C:\\game\u{0}file"] {
        assert!(require_narrow_windows_path(Path::new(path), "").is_err());
    }
    assert!(require_narrow_windows_path(Path::new(&"a".repeat(259)), "").is_ok());
    assert!(require_narrow_windows_path(Path::new(&"a".repeat(260)), "").is_err());
    assert!(
        require_narrow_windows_path(Path::new(&format!("\\\\?\\{}", "a".repeat(259))), "").is_ok()
    );
    assert!(require_narrow_windows_path(Path::new(&"a".repeat(258)), "ab").is_err());
}
#[test]
fn retained_shared_scope_requires_binding_and_refuses_unknown_semantics() {
    let spec: UserPreparedRuntimeSpec = serde_json::from_value(serde_json::json!({
        "version":"0.4.1", "archive_name":"Resident_Evil_Gaiden_Recomp_v0.4.1_Windows.zip",
        "archive_size":33085815, "archive_sha256":"d16ba320c75a23765ef1e84c6f70f551612834914c70fd4c542e20ae7ce5dcc6",
        "executable":"Resident_Evil_Gaiden__USA_.exe", "immutable_tree_sha256":"a".repeat(64),
        "shared_preferences":"regaiden041-windows", "source_argument_extension":"gbc",
        "mutable_paths":["runtime_prefs.ini", "config.ini", "saves", "snapshots", "imgui.ini"]
    })).unwrap();
    validate(&spec).unwrap();
    let mut missing_window_state = spec.clone();
    missing_window_state
        .mutable_paths
        .retain(|path| path != "imgui.ini");
    assert!(validate(&missing_window_state).is_err());
    let mut extra_path = spec.clone();
    extra_path.mutable_paths.push("arbitrary.ini".into());
    assert!(validate(&extra_path).is_err());
    let mut wrong_artifact = spec.clone();
    wrong_artifact.archive_sha256 = "f".repeat(64);
    assert!(validate(&wrong_artifact).is_err());
    wrong_artifact = spec.clone();
    wrong_artifact.executable = "other.exe".into();
    assert!(validate(&wrong_artifact).is_err());
    let mut record: ExternalRuntimeRecord = serde_json::from_value(serde_json::json!({
        "id":"fixture", "port_id":"fixture", "path":"external", "executable":"fixture.exe",
        "version":"0.4.1", "platform":"windows-x86-64", "archive_sha256":"a".repeat(64),
        "immutable_tree_sha256":"b".repeat(64), "registered_at":1
    }))
    .unwrap();
    assert!(check_binding(&record, &spec).is_err());
    record.shared_preferences = Some(crate::AcceptedSharedPreferencesBinding {
        contract: PreparedSharedPreferencesContract::Regaiden041Windows,
        account_sid_sha256: "c".repeat(64),
        path: "shared-fixture".into(),
    });
    check_binding(&record, &spec).unwrap();
    let mut legacy = spec.clone();
    legacy.shared_preferences = None;
    assert!(check_binding(&record, &legacy).is_err());
    record
        .shared_preferences
        .as_mut()
        .unwrap()
        .account_sid_sha256 = "unrecognized-account".into();
    assert!(check_binding(&record, &spec).is_err());
    let mut unknown = serde_json::to_value(&spec).unwrap();
    unknown["shared_preferences"] = "arbitrary-shared-path".into();
    assert!(serde_json::from_value::<UserPreparedRuntimeSpec>(unknown).is_err());
}
#[test]
fn generic_confirmation_and_stale_ack_cannot_accept_shared_scope() {
    let mut preview = crate::ExternalRuntimePreview {
        user_selected: None,
        port_id: "scope-probe".into(),
        path: "external".into(),
        executable: "game.exe".into(),
        version: "0.4.1".into(),
        archive_sha256: "a".repeat(64),
        immutable_tree_sha256: "b".repeat(64),
        immutable_file_count: 1,
        preview_sha256: "c".repeat(64),
        shared_preferences: Some(crate::SharedPreferencesReview {
            binding: crate::AcceptedSharedPreferencesBinding {
                contract: crate::PreparedSharedPreferencesContract::Regaiden041Windows,
                account_sid_sha256: "d".repeat(64),
                path: "shared-preferences".into(),
            },
            present: false,
            local_fallback_path: Some("external/runtime_prefs.ini".into()),
            local_fallback_present: false,
        }),
    };
    assert!(require_ack(&preview, None).is_err());
    assert!(require_ack(&preview, Some(&"e".repeat(64))).is_err());
    assert!(require_ack(&preview, Some(&preview.preview_sha256)).is_ok());
    preview.shared_preferences = None;
    assert!(require_ack(&preview, None).is_ok());
    assert!(require_ack(&preview, Some(&preview.preview_sha256)).is_err());
}
#[test]
fn missing_shared_data_is_not_created_and_ordinary_edits_are_allowed() {
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("runtime").join("runtime_prefs.ini");
    assert!(!check_path(&file, false).unwrap());
    assert!(!file.parent().unwrap().exists());
    fs::create_dir(file.parent().unwrap()).unwrap();
    fs::write(&file, b"audio=1").unwrap();
    assert!(check_path(&file, false).unwrap());
    fs::write(&file, b"audio=0\nunknown=player-owned").unwrap();
    assert!(check_path(&file, false).unwrap());
    assert_eq!(fs::read(&file).unwrap(), b"audio=0\nunknown=player-owned");
}
#[test]
fn shared_data_refuses_file_ancestors_directories_and_hard_links() {
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("runtime_prefs.ini");
    fs::create_dir(&file).unwrap();
    assert!(check_path(&file, false).is_err());
    fs::remove_dir(&file).unwrap();
    fs::write(&file, b"data").unwrap();
    assert!(check_path(&file.join("child"), false).is_err());
    fs::hard_link(&file, root.path().join("alias")).unwrap();
    assert!(check_path(&file, false).is_err());
}
