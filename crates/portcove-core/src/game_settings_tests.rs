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
