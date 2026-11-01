use super::*;

fn hidden(port: &str) -> OrganizationChange {
    OrganizationChange::SetHidden {
        port_id: port.into(),
        hidden: true,
    }
}

#[test]
fn explicit_implementation_choice_survives_restart_and_never_changes_other_library_choices() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("preferences.json");
    let id = uuid::Uuid::new_v4().simple().to_string();
    let other = uuid::Uuid::new_v4().simple().to_string();
    let store = HostPreferenceStore::new(path.clone()).unwrap();
    let initial = store
        .change_library_organization(&id, 0, hidden("unrelated"))
        .unwrap();
    let selected = store
        .change_library_organization(
            &id,
            initial.revision,
            OrganizationChange::SetPreferredImplementation {
                game_id: "majoras-mask".into(),
                port_id: Some("2ship2harkinian".into()),
            },
        )
        .unwrap();
    let restarted = HostPreferenceStore::new(path.clone()).unwrap();
    assert_eq!(restarted.library_organization(&id).unwrap(), selected);
    assert_eq!(
        selected.preferred_port_by_game["majoras-mask"],
        "2ship2harkinian"
    );
    assert!(selected.hidden_port_ids.contains("unrelated"));
    assert!(
        restarted
            .library_organization(&other)
            .unwrap()
            .preferred_port_by_game
            .is_empty()
    );
    let bytes = fs::read(&path).unwrap();
    assert!(
        restarted
            .change_library_organization(
                &id,
                initial.revision,
                OrganizationChange::SetPreferredImplementation {
                    game_id: "majoras-mask".into(),
                    port_id: Some("zelda64-recomp".into())
                }
            )
            .is_err()
    );
    assert_eq!(fs::read(&path).unwrap(), bytes);
    assert!(
        restarted
            .change_library_organization(
                &id,
                selected.revision,
                OrganizationChange::SetPreferredImplementation {
                    game_id: "majoras-mask".into(),
                    port_id: Some("invalid/id".into())
                }
            )
            .is_err()
    );
    assert_eq!(fs::read(&path).unwrap(), bytes);
    let cleared = restarted
        .change_library_organization(
            &id,
            selected.revision,
            OrganizationChange::SetPreferredImplementation {
                game_id: "majoras-mask".into(),
                port_id: None,
            },
        )
        .unwrap();
    assert!(cleared.preferred_port_by_game.is_empty());
    assert_eq!(cleared.hidden_port_ids, selected.hidden_port_ids);
}

#[test]
fn organization_survives_restart_move_and_preserves_unknown_records() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("library");
    let library_id = crate::Library::open(root.clone())
        .unwrap()
        .identity_record()
        .unwrap()
        .id;
    let other_id = uuid::Uuid::new_v4().simple().to_string();
    let path = temp.path().join("preferences.json");
    fs::write(&path, serde_json::to_vec(&serde_json::json!({
        "format_version": 1, "future_setting": { "keep": true },
        ORGANIZATION_KEY: {
            library_id.clone(): { "future_choice": [1,2], "collections": { "weekend": { "name": "Weekend", "port_ids": ["absent-port"], "future_collection": true } } },
            other_id.clone(): { "future_format": "leave untouched" }
        }
    })).unwrap()).unwrap();
    let store = HostPreferenceStore::new(path.clone()).unwrap();
    let first = store
        .change_library_organization(&library_id, 0, hidden("unknown-port"))
        .unwrap();
    let second = store
        .change_library_organization(
            &library_id,
            first.revision,
            OrganizationChange::UpsertCollection {
                collection_id: "weekend".into(),
                name: "Weekend games".into(),
            },
        )
        .unwrap();
    store.set_favorite(&library_id, "other-port", true).unwrap();
    store.set_locale_preference(Some("fr")).unwrap();
    fs::rename(&root, temp.path().join("moved")).unwrap();
    assert_eq!(
        crate::Library::open(temp.path().join("moved"))
            .unwrap()
            .identity_record()
            .unwrap()
            .id,
        library_id
    );
    let restarted = HostPreferenceStore::new(path.clone()).unwrap();
    assert_eq!(restarted.library_organization(&library_id).unwrap(), second);
    let value: serde_json::Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    assert_eq!(value["future_setting"]["keep"], true);
    assert_eq!(
        value[ORGANIZATION_KEY][&library_id]["future_choice"],
        serde_json::json!([1, 2])
    );
    assert_eq!(
        value[ORGANIZATION_KEY][&library_id]["collections"]["weekend"]["future_collection"],
        true
    );
    assert_eq!(
        value[ORGANIZATION_KEY][other_id]["future_format"],
        "leave untouched"
    );
}

#[test]
fn stale_concurrent_choices_fail_without_overwriting_and_other_library_stays_separate() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("preferences.json");
    let id = uuid::Uuid::new_v4().simple().to_string();
    let other = uuid::Uuid::new_v4().simple().to_string();
    let first = HostPreferenceStore::new(path.clone()).unwrap();
    let second = HostPreferenceStore::new(path.clone()).unwrap();
    assert_eq!(first.library_organization(&id).unwrap().revision, 0);
    assert!(!path.exists());
    first
        .change_library_organization(&id, 0, hidden("one"))
        .unwrap();
    let bytes = fs::read(&path).unwrap();
    assert_eq!(
        second
            .change_library_organization(&id, 0, hidden("two"))
            .unwrap_err()
            .code,
        crate::ErrorCode::Conflict
    );
    assert_eq!(fs::read(&path).unwrap(), bytes);
    assert!(
        second
            .library_organization(&other)
            .unwrap()
            .hidden_port_ids
            .is_empty()
    );
    let snapshot = second
        .change_library_organization(&id, 1, hidden("two"))
        .unwrap();
    assert_eq!(
        snapshot.hidden_port_ids,
        BTreeSet::from(["one".into(), "two".into()])
    );
}

#[test]
fn malformed_and_oversized_choices_never_replace_saved_bytes() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("preferences.json");
    let id = uuid::Uuid::new_v4().simple().to_string();
    let store = HostPreferenceStore::new(path.clone()).unwrap();
    let malformed = serde_json::to_vec(&serde_json::json!({ "format_version": 1, ORGANIZATION_KEY: { id.clone(): { "hidden_port_ids": false } } })).unwrap();
    fs::write(&path, &malformed).unwrap();
    assert!(store.library_organization(&id).is_err());
    assert!(
        store
            .change_library_organization(&id, 0, hidden("one"))
            .is_err()
    );
    assert_eq!(fs::read(&path).unwrap(), malformed);
    let large = serde_json::to_vec(
        &serde_json::json!({ "format_version": 1, "future": "x".repeat(65_350) }),
    )
    .unwrap();
    fs::write(&path, &large).unwrap();
    assert!(large.len() < 65_536);
    assert!(
        store
            .change_library_organization(&id, 0, hidden("one"))
            .is_err()
    );
    assert_eq!(fs::read(&path).unwrap(), large);
}

#[test]
fn attestation_scopes_and_skipped_release_bytes_are_distinct() {
    let temp = tempfile::tempdir().unwrap();
    let store = HostPreferenceStore::new(temp.path().join("preferences.json")).unwrap();
    let id = uuid::Uuid::new_v4().simple().to_string();
    let external = SetupConfirmation {
        port_id: "port".into(),
        context: InstallationContext::External {
            installation_id: "same-id".into(),
        },
    };
    let snapshot = store
        .change_library_organization(
            &id,
            0,
            OrganizationChange::SetSetupConfirmation {
                confirmation: external.clone(),
                confirmed: true,
            },
        )
        .unwrap();
    assert!(snapshot.setup_confirmations.contains(&external));
    assert!(!snapshot.setup_confirmations.contains(&SetupConfirmation {
        port_id: "port".into(),
        context: InstallationContext::Managed {
            installation_id: "same-id".into()
        }
    }));
    assert!(!snapshot.setup_confirmations.contains(&SetupConfirmation {
        port_id: "port".into(),
        context: InstallationContext::External {
            installation_id: "replacement".into()
        }
    }));
    let invalid = OrganizationChange::SetUpdateNotice {
        port_id: "port".into(),
        choice: UpdateNoticeChoice {
            paused: false,
            skipped_release: Some(UpdateNoticeRelease {
                version: "v1".into(),
                artifact_sha256: String::new(),
            }),
            ..Default::default()
        },
    };
    assert!(store.change_library_organization(&id, 1, invalid).is_err());
    let choice = UpdateNoticeChoice {
        paused: false,
        skipped_release: Some(UpdateNoticeRelease {
            version: "v1".into(),
            artifact_sha256: "a".repeat(64),
        }),
        ..Default::default()
    };
    let snapshot = store
        .change_library_organization(
            &id,
            1,
            OrganizationChange::SetUpdateNotice {
                port_id: "port".into(),
                choice,
            },
        )
        .unwrap();
    assert_eq!(
        snapshot.update_notices["port"]
            .skipped_release
            .as_ref()
            .unwrap()
            .artifact_sha256,
        "a".repeat(64)
    );
}

#[test]
fn saved_identity_enrichment_keeps_exact_aliases_and_unsaves_atomically() {
    let temp = tempfile::tempdir().unwrap();
    let store = HostPreferenceStore::new(temp.path().join("preferences.json")).unwrap();
    let library = "a".repeat(32);
    let port_id = "p".repeat(128);
    let legacy = format!("port-{port_id}");
    let game_id = format!("game-{}", "g".repeat(128));
    let first = store
        .change_library_organization(
            &library,
            0,
            OrganizationChange::SetSaved {
                game_id: legacy.clone(),
                saved: true,
            },
        )
        .unwrap();
    let second = store
        .change_library_organization(
            &library,
            first.revision,
            OrganizationChange::SetSavedGroup {
                game_id: game_id.clone(),
                legacy_port_ids: vec![port_id.clone()],
                saved: true,
            },
        )
        .unwrap();
    assert!(second.saved_game_ids.contains(&legacy));
    assert!(second.saved_game_ids.contains(&game_id));
    let third = store
        .change_library_organization(
            &library,
            second.revision,
            OrganizationChange::SetSavedGroup {
                game_id,
                legacy_port_ids: vec![port_id],
                saved: false,
            },
        )
        .unwrap();
    assert!(third.saved_game_ids.is_empty());
    assert_eq!(third.revision, second.revision + 1);
}
