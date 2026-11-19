use super::*;
use serde_json::json;

fn fixture() -> GameSettingsContract {
    serde_json::from_value(json!({
        "format_version": 1,
        "releases": [{
            "version": "v1.8.0",
            "platform": "windows-x86-64",
            "archive_sha256": "a".repeat(64),
            "source_commit": "b".repeat(40),
            "evidence_urls": ["https://github.com/example/port/blob/pinned/config.cpp"]
        }],
        "files": [{
            "id": "launcher",
            "path": "GoldenBalloon/mdkr64_app.ini",
            "format": "ini",
            "maximum_bytes": 524288,
            "settings": [{
                "id": "interface-scale",
                "label": "Interface scale",
                "key": ["ui_scale"],
                "value": {
                    "kind": "number", "minimum": 0.75, "maximum": 3.0,
                    "step": 0.05, "default": 1.0
                }
            }]
        }]
    }))
    .unwrap()
}

fn persistence() -> Vec<String> {
    vec!["GoldenBalloon/mdkr64_app.ini".into()]
}

#[test]
fn declaration_is_bounded_data_without_filesystem_or_execution_authority() {
    fixture().validate(&persistence()).unwrap();
    assert!(fixture().validate(&[]).is_err());
    let mut value = fixture();
    value.releases[0].archive_sha256.clear();
    assert!(value.validate(&persistence()).is_err());
    let mut value = fixture();
    value.releases[0].platform = Platform::LinuxX86_64;
    assert!(value.validate(&persistence()).is_err());
    let mut value = fixture();
    value.releases.push(value.releases[0].clone());
    assert!(value.validate(&persistence()).is_err());
}

#[test]
fn configuration_paths_refuse_escape_alias_and_non_configuration_targets() {
    for path in [
        "../mdkr64_app.ini",
        "/mdkr64_app.ini",
        "C:/mdkr64_app.ini",
        "GoldenBalloon\\mdkr64_app.ini",
        "GoldenBalloon/mdkr64_app.ini:stream",
        "GoldenBalloon/../mdkr64_app.ini",
        "GoldenBalloon/mdkr64_app.ini.",
        "GoldenBalloon/rom.z64",
        "GoldenBalloon/player.exe",
        ".portcove-manifest.json",
        "GoldenBalloon/.PORTCOVE-manifest.json",
        ".portcove-private/preferences.ini",
    ] {
        let mut value = fixture();
        value.files[0].path = path.into();
        assert!(value.validate(&[path.into()]).is_err(), "{path}");
    }
    let mut value = fixture();
    let mut alias = value.files[0].clone();
    alias.id = "alias".into();
    alias.path = alias.path.to_ascii_uppercase();
    alias.settings[0].id = "alias-scale".into();
    value.files.push(alias);
    assert!(
        value
            .validate(&["GoldenBalloon".into(), "GOLDENBALLOON".into()])
            .is_err()
    );
}

#[test]
fn numeric_choices_are_finite_typed_and_exactly_bounded() {
    let value = &fixture().files[0].settings[0].value;
    for accepted in [json!(0.75), json!(1), json!(1.25), json!(3.0)] {
        assert!(value.accepts(&accepted), "{accepted}");
    }
    for refused in [
        json!(0.70),
        json!(3.05),
        json!(1.01),
        json!("1.25"),
        json!(true),
    ] {
        assert!(!value.accepts(&refused), "{refused}");
    }
    for (minimum, maximum, step, default) in [
        (0.0, 1.0, 0.1, 1.1),
        (0.0, 1.0, 0.1, 0.15),
        (1.0, 0.0, 0.1, 0.0),
        (0.0, 1.0, 0.0, 0.0),
        (0.0, f64::INFINITY, 0.1, 0.0),
        (0.0, 1.0, 0.1, f64::NAN),
    ] {
        let mut contract = fixture();
        contract.files[0].settings[0].value = GameSettingType::Number {
            minimum,
            maximum,
            step,
            default,
        };
        assert!(contract.validate(&persistence()).is_err());
    }
}

#[test]
fn integer_json_consumers_never_receive_floating_point_or_string_values() {
    let value = GameSettingType::Integer {
        minimum: 0,
        maximum: 100,
        step: 1,
        default: 40,
    };
    value.validate("volume").unwrap();
    assert!(value.accepts(&json!(70)));
    assert!(!value.accepts(&json!(70.0)));
    assert!(!value.accepts(&json!("70")));
    assert_eq!(serde_json::to_string(&value.default_value()).unwrap(), "40");
    assert!(!value.accepts(&json!(101)));
    assert!(!value.accepts(&json!(-1)));
}

#[test]
fn supported_key_identity_cannot_be_ambiguous_or_executable() {
    for key in [
        vec![],
        vec!["ui\nscale"],
        vec!["ui=scale"],
        vec!["[ui]"],
        vec!["section", "ui_scale"],
    ] {
        let mut value = fixture();
        value.files[0].settings[0].key = key.into_iter().map(str::to_owned).collect();
        assert!(value.validate(&persistence()).is_err());
    }
    let mut value = fixture();
    let mut duplicate = value.files[0].settings[0].clone();
    duplicate.id = "another".into();
    value.files[0].settings.push(duplicate);
    assert!(value.validate(&persistence()).is_err());
    let mut value = fixture();
    value.files[0].path = "settings.json".into();
    value.files[0].format = GameSettingsFormat::Json;
    value.files[0].settings[0].key = vec!["CVars".into()];
    let mut nested = value.files[0].settings[0].clone();
    nested.id = "nested".into();
    nested.key.push("Volume".into());
    value.files[0].settings.push(nested);
    assert!(value.validate(&["settings.json".into()]).is_err());
}

#[test]
fn enum_defaults_require_unique_bounded_scalar_choices() {
    let mut value = fixture();
    value.files[0].settings[0].value = GameSettingType::Enum {
        choices: vec![
            GameSettingChoice {
                label: "Quiet".into(),
                value: json!(0),
            },
            GameSettingChoice {
                label: "Normal".into(),
                value: json!(1),
            },
        ],
        default: json!(1),
    };
    value.validate(&persistence()).unwrap();
    let GameSettingType::Enum { choices, .. } = &mut value.files[0].settings[0].value else {
        panic!("enum fixture");
    };
    choices.push(choices[0].clone());
    assert!(value.validate(&persistence()).is_err());
    for refused in [
        json!(null),
        json!({"command": "run"}),
        json!([1]),
        json!("line\nbreak"),
    ] {
        let mut value = fixture();
        value.files[0].settings[0].value = GameSettingType::Enum {
            choices: vec![GameSettingChoice {
                label: "Untrusted".into(),
                value: refused.clone(),
            }],
            default: refused,
        };
        assert!(value.validate(&persistence()).is_err());
    }
}

#[test]
fn descriptor_shape_refuses_unknown_execution_and_write_semantics() {
    let source = serde_json::to_value(fixture()).unwrap();
    for field in ["command", "environment", "always", "clear", "ensure"] {
        let mut value = source.clone();
        value["files"][0][field] = json!("untrusted");
        assert!(
            serde_json::from_value::<GameSettingsContract>(value).is_err(),
            "{field}"
        );
    }
    let mut value = fixture();
    value.format_version = 2;
    assert!(value.validate(&persistence()).is_err());
    let mut value = fixture();
    value.files[0].maximum_bytes = MAX_SETTINGS_BYTES + 1;
    assert!(value.validate(&persistence()).is_err());
}

#[test]
fn shipped_defaults_require_one_exact_archive_and_a_bounded_declared_file() {
    let catalog = crate::Catalog::embedded().unwrap();
    let mut port = catalog.port("shipwright").unwrap().clone();
    let contract = fixture();
    let release = contract.releases[0].clone();
    let file = contract.files[0].clone();
    port.game_settings = Some(contract);
    port.persistent_paths = persistence();
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join(&file.path);
    let capture = |platform, version: &str, archive: &str| {
        capture_shipped_defaults(&port, platform, version, archive, root.path())
    };

    let scan = || {
        capture_shipped_settings(
            &port,
            release.platform,
            &release.version,
            &release.archive_sha256,
            root.path(),
        )
    };
    assert_eq!(
        scan().gaps.get(&file.path),
        Some(&ShippedDefaultGap::Omitted)
    );
    assert!(capture(release.platform, &release.version, &release.archive_sha256).is_empty());
    std::fs::create_dir(path.parent().unwrap()).unwrap();
    std::fs::write(&path, [0xff]).unwrap();
    assert_eq!(
        scan().gaps.get(&file.path),
        Some(&ShippedDefaultGap::Malformed)
    );
    std::fs::write(&path, vec![b'x'; file.maximum_bytes as usize + 1]).unwrap();
    assert_eq!(
        scan().gaps.get(&file.path),
        Some(&ShippedDefaultGap::Unreadable)
    );
    let default = b"ui_scale=1.0\r\nunknown=retained\r\n";
    std::fs::write(&path, default).unwrap();
    let retained = capture(release.platform, &release.version, &release.archive_sha256);
    assert!(scan().gaps.is_empty());
    assert_eq!(
        retained,
        BTreeMap::from([(
            file.path.clone(),
            ShippedDefault {
                sha256: hex::encode(Sha256::digest(default)),
                bytes_hex: hex::encode(default),
            },
        )])
    );
    let reopen = |port: &crate::PortDefinition,
                  version: &str,
                  archive: &str,
                  defaults: &BTreeMap<String, ShippedDefault>| {
        verify_shipped_defaults(
            port,
            release.platform,
            version,
            archive,
            defaults,
            &BTreeMap::new(),
        )
    };
    reopen(&port, &release.version, &release.archive_sha256, &retained).unwrap();
    assert!(reopen(&port, "v1.8.1", &release.archive_sha256, &retained).is_err());
    assert!(reopen(&port, &release.version, &"b".repeat(64), &retained).is_err());
    let mut unqualified = port.clone();
    unqualified.game_settings = None;
    assert!(
        reopen(
            &unqualified,
            &release.version,
            &release.archive_sha256,
            &retained
        )
        .is_err()
    );
    reopen(
        &unqualified,
        &release.version,
        &release.archive_sha256,
        &BTreeMap::new(),
    )
    .unwrap();
    let valid = retained[&file.path].clone();
    let wrong_path = BTreeMap::from([("foreign.ini".into(), valid.clone())]);
    assert!(
        reopen(
            &port,
            &release.version,
            &release.archive_sha256,
            &wrong_path
        )
        .is_err()
    );
    let corrupt = BTreeMap::from([(
        file.path.clone(),
        ShippedDefault {
            sha256: "0".repeat(64),
            ..valid
        },
    )]);
    assert!(reopen(&port, &release.version, &release.archive_sha256, &corrupt).is_err());
    assert!(
        capture(
            Platform::LinuxX86_64,
            &release.version,
            &release.archive_sha256
        )
        .is_empty()
    );
    assert!(capture(release.platform, "v1.8.1", &release.archive_sha256).is_empty());
    assert!(capture(release.platform, &release.version, &"b".repeat(64)).is_empty());
    std::fs::write(&path, vec![b' '; file.maximum_bytes as usize + 1]).unwrap();
    assert!(capture(release.platform, &release.version, &release.archive_sha256).is_empty());
}

#[test]
fn shipped_default_reconciliation_preserves_exact_bytes_and_recorded_deletion() {
    let file = fixture().files.remove(0);
    let old_bytes = b"ui_scale=1.0\r\n";
    let incoming_bytes = b"ui_scale=1.5\r\n";
    let player_bytes = b"ui_scale=1.25\r\n; player note\r\n";
    let receipt = |bytes: &[u8]| ShippedDefault {
        sha256: hex::encode(Sha256::digest(bytes)),
        bytes_hex: hex::encode(bytes),
    };
    let old = receipt(old_bytes);
    let incoming = receipt(incoming_bytes);
    let plan = |old: Option<&ShippedDefault>, player, incoming| {
        reconcile_shipped_default(&file, old.map(|value| (&file, value)), player, incoming).unwrap()
    };

    assert_eq!(
        plan(
            Some(&old),
            PlayerSettings::Present(old_bytes),
            Some(&incoming)
        ),
        SettingsUpdate::InstallDefault(incoming_bytes.to_vec())
    );
    assert_eq!(
        plan(
            Some(&old),
            PlayerSettings::Present(player_bytes),
            Some(&old)
        ),
        SettingsUpdate::KeepPlayer
    );
    assert_eq!(
        plan(
            Some(&old),
            PlayerSettings::Present(incoming_bytes),
            Some(&incoming)
        ),
        SettingsUpdate::KeepPlayer
    );
    for player in [
        PlayerSettings::Present(player_bytes),
        PlayerSettings::RecordedDeletion,
    ] {
        assert_eq!(
            plan(Some(&old), player, Some(&incoming)),
            SettingsUpdate::KeepPlayerAndDefault(incoming_bytes.to_vec())
        );
    }
    assert_eq!(
        plan(None, PlayerSettings::Present(player_bytes), Some(&incoming)),
        SettingsUpdate::MissingBaseline {
            incoming_default: Some(incoming_bytes.to_vec())
        }
    );
    assert_eq!(
        plan(Some(&old), PlayerSettings::Unobserved, Some(&incoming)),
        SettingsUpdate::MissingPlayerEvidence(incoming_bytes.to_vec())
    );
    assert_eq!(
        plan(Some(&old), PlayerSettings::RecordedDeletion, Some(&old)),
        SettingsUpdate::KeepPlayer
    );
    let altered = ShippedDefault {
        bytes_hex: old.bytes_hex.clone(),
        ..incoming
    };
    assert!(
        reconcile_shipped_default(
            &file,
            Some((&file, &old)),
            PlayerSettings::Present(old_bytes),
            Some(&altered)
        )
        .is_err()
    );
}

#[test]
fn retained_settings_plan_binds_the_player_preimage_and_file_identity() {
    let old_bytes = b"ui_scale=1.0\r\n";
    let incoming_bytes = b"ui_scale=1.5\r\n";
    let retained = |bytes: &[u8]| {
        let contract = fixture();
        let shipped = BTreeMap::from([(
            contract.files[0].path.clone(),
            ShippedDefault {
                sha256: hex::encode(Sha256::digest(bytes)),
                bytes_hex: hex::encode(bytes),
            },
        )]);
        RetainedSettingsDefaults {
            contract,
            shipped,
            capture_gaps: BTreeMap::new(),
        }
    };
    let prior = retained(old_bytes);
    let mut incoming = retained(incoming_bytes);
    let path = incoming.contract.files[0].path.clone();
    let player = BTreeMap::from([(path.clone(), PlayerSettings::Present(old_bytes))]);
    let plan = incoming.plan_update(Some(&prior), &player).unwrap();
    assert_eq!(plan.len(), 1);
    assert_eq!(plan[0].path, path);
    assert_eq!(
        plan[0].player_preimage,
        SettingsPreimage::Present {
            sha256: hex::encode(Sha256::digest(old_bytes))
        }
    );
    assert_eq!(
        plan[0].update,
        SettingsUpdate::InstallDefault(incoming_bytes.to_vec())
    );
    let temporary = tempfile::tempdir().unwrap();
    let canonical = temporary.path().join(&path);
    std::fs::create_dir_all(canonical.parent().unwrap()).unwrap();
    std::fs::write(&canonical, old_bytes).unwrap();
    plan[0]
        .require_unchanged_player(&incoming.contract.files[0], temporary.path(), None)
        .unwrap();

    let deleted = BTreeMap::from([(path, PlayerSettings::RecordedDeletion)]);
    let plan = incoming.plan_update(Some(&prior), &deleted).unwrap();
    assert_eq!(plan[0].player_preimage, SettingsPreimage::RecordedDeletion);
    assert_eq!(
        plan[0].update,
        SettingsUpdate::KeepPlayerAndDefault(incoming_bytes.to_vec())
    );

    incoming.contract.files[0].id = "replacement".into();
    let plan = incoming.plan_update(Some(&prior), &player).unwrap();
    assert_eq!(
        plan[0].update,
        SettingsUpdate::MissingBaseline {
            incoming_default: Some(incoming_bytes.to_vec())
        }
    );
}

#[test]
fn settings_preimage_rechecks_mirrors_and_requires_deletion_evidence() {
    let temporary = tempfile::tempdir().unwrap();
    let canonical = temporary.path().join("canonical");
    let runtime = temporary.path().join("old-runtime");
    let contract = fixture();
    let file = &contract.files[0];
    let config = canonical.join(&file.path);
    let mirror = runtime.join(&file.path);
    let original = b"ui_scale=1.25\r\n; player note\r\n";
    for copy in [&config, &mirror] {
        std::fs::create_dir_all(copy.parent().unwrap()).unwrap();
        std::fs::write(copy, original).unwrap();
    }
    let mut plan = SettingsFileUpdate {
        path: file.path.clone(),
        file_id: file.id.clone(),
        format: file.format,
        player_preimage: SettingsPreimage::Present {
            sha256: hex::encode(Sha256::digest(original)),
        },
        update: SettingsUpdate::InstallDefault(b"ui_scale=1.5\r\n".to_vec()),
    };
    plan.require_unchanged_player(file, &canonical, Some(&runtime))
        .unwrap();

    let mut unrelated = file.clone();
    unrelated.id = "unrelated-config".into();
    assert!(
        plan.require_unchanged_player(&unrelated, &canonical, Some(&runtime))
            .is_err()
    );

    let concurrent = b"ui_scale=1.75\r\n; newer player write\r\n";
    std::fs::write(&mirror, concurrent).unwrap();
    assert!(
        plan.require_unchanged_player(file, &canonical, Some(&runtime))
            .is_err()
    );
    assert_eq!(std::fs::read(&config).unwrap(), original);
    assert_eq!(std::fs::read(&mirror).unwrap(), concurrent);
    std::fs::write(&config, concurrent).unwrap();
    assert!(
        plan.require_unchanged_player(file, &canonical, Some(&runtime))
            .is_err()
    );

    std::fs::remove_file(&config).unwrap();
    std::fs::remove_file(&mirror).unwrap();
    plan.player_preimage = SettingsPreimage::Unobserved;
    assert_eq!(
        observe_player_settings_copy(&canonical, file).unwrap(),
        None
    );
    assert!(
        plan.require_unchanged_player(file, &canonical, Some(&runtime))
            .is_err()
    );
    plan.player_preimage = SettingsPreimage::RecordedDeletion;
    plan.require_unchanged_player(file, &canonical, Some(&runtime))
        .unwrap();
    std::fs::write(&config, concurrent).unwrap();
    assert!(
        plan.require_unchanged_player(file, &canonical, Some(&runtime))
            .is_err()
    );
    assert!(
        plan.require_unchanged_player(file, &canonical, None)
            .is_err()
    );
    assert_eq!(std::fs::read(&config).unwrap(), concurrent);
    assert!(!mirror.exists());
}
