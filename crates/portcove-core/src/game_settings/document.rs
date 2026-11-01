//! Pure, bounded configuration interpretation. This module grants no file access
//! or mutation authority; the service must bind bytes to a retained installation.

use serde_json::Value;

use super::{GameSetting, GameSettingType, GameSettingsFile, GameSettingsFormat};
use crate::{PortcoveError, Result, definition_entry::strict_json::UniqueValue};

fn invalid(message: &str) -> PortcoveError {
    PortcoveError::conflict(message)
}

fn text<'a>(file: &GameSettingsFile, bytes: &'a [u8]) -> Result<&'a str> {
    if bytes.len() as u64 > file.maximum_bytes {
        return Err(invalid("configuration exceeds its retained size limit"));
    }
    let text = std::str::from_utf8(bytes)
        .map_err(|_| invalid("configuration must be UTF-8 without replacement characters"))?;
    if file.format == GameSettingsFormat::Ini
        && (text.contains('\0') || text.split('\n').any(|line| line.len() > 384 * 1024))
    {
        return Err(invalid(
            "flat INI contains NUL or an overlong physical line",
        ));
    }
    Ok(text)
}

fn json_document(text: &str) -> Result<Value> {
    let UniqueValue(document) = serde_json::from_str(text)
        .map_err(|_| invalid("configuration must be JSON with unique object keys"))?;
    if !document.is_object() {
        return Err(invalid("configuration must be a JSON object"));
    }
    Ok(document)
}

// Libultraship flattens nested object keys using dots. Refuse an alternate
// spelling of a declared key instead of writing a second competing CVar.
fn refuse_json_aliases(document: &Value, key: &[String]) -> Result<()> {
    fn visit(value: &Value, path: &mut Vec<String>, key: &[String]) -> Result<()> {
        if path.as_slice() != key && path.join(".") == key.join(".") {
            return Err(invalid(
                "configuration contains an ambiguous dotted setting key",
            ));
        }
        if let Some(object) = value.as_object() {
            for (name, child) in object {
                path.push(name.clone());
                visit(child, path, key)?;
                path.pop();
            }
        }
        Ok(())
    }
    visit(document, &mut Vec::new(), key)
}

fn json_value(document: &Value, key: &[String]) -> Result<Option<Value>> {
    refuse_json_aliases(document, key)?;
    let mut parent = document;
    for component in key {
        let object = parent.as_object().ok_or_else(|| {
            invalid("configuration setting parent has an unsupported non-object type")
        })?;
        if object
            .get("Type")
            .and_then(Value::as_str)
            .is_some_and(|tag| matches!(tag, "RGB" | "RGBA"))
        {
            return Err(invalid(
                "configuration setting is below a tagged color leaf",
            ));
        }
        let Some(child) = object.get(component) else {
            return Ok(None);
        };
        parent = child;
    }
    Ok(Some(parent.clone()))
}

fn ini_line(line: &str) -> Option<(&str, &str)> {
    let line = line.strip_suffix('\n').unwrap_or(line);
    let line = line.strip_suffix('\r').unwrap_or(line);
    if line.starts_with('#') {
        return None;
    }
    // No trimming: Golden Balloon's AppConfig keys are case-sensitive and
    // leading/trailing whitespace changes their identity.
    line.split_once('=')
}

fn ini_scalar(value: &str, setting: &GameSetting) -> Result<Value> {
    let result = match &setting.value {
        GameSettingType::Enum { choices, .. } => choices
            .iter()
            .find(|choice| scalar_text(&choice.value).is_ok_and(|text| text == value))
            .map(|choice| choice.value.clone()),
        GameSettingType::Boolean { .. } => match value {
            "true" => Some(Value::Bool(true)),
            "false" => Some(Value::Bool(false)),
            _ => None,
        },
        GameSettingType::Integer { .. } => value.parse::<i64>().ok().map(Value::from),
        GameSettingType::Number { .. } => value
            .parse::<f64>()
            .ok()
            .filter(|number| number.is_finite())
            .map(Value::from),
    };
    result.ok_or_else(|| invalid("configuration setting has an unsupported value encoding"))
}

fn scalar_text(value: &Value) -> Result<String> {
    match value {
        Value::String(text) if text.chars().all(|ch| !ch.is_control() && ch != '\\') => {
            Ok(text.clone())
        }
        Value::Bool(_) | Value::Number(_) => Ok(value.to_string()),
        _ => Err(invalid(
            "setting cannot be represented by flat INI version one",
        )),
    }
}

pub(crate) fn validate_file_declaration(file: &GameSettingsFile) -> Result<()> {
    if file.format == GameSettingsFormat::Ini {
        for setting in &file.settings {
            if let GameSettingType::Enum { choices, .. } = &setting.value {
                let mut encodings = std::collections::BTreeSet::new();
                for choice in choices {
                    if !encodings.insert(scalar_text(&choice.value)?) {
                        return Err(invalid("flat INI enum choices have ambiguous encodings"));
                    }
                }
            }
        }
    }
    Ok(())
}

fn ini_value(text: &str, setting: &GameSetting) -> Result<Option<Value>> {
    let key = setting
        .key
        .first()
        .ok_or_else(|| invalid("missing setting key"))?;
    let mut found = None;
    for line in text.split_inclusive('\n') {
        if let Some((name, value)) = ini_line(line)
            && name == key
        {
            if found.is_some() {
                return Err(invalid(
                    "configuration contains a duplicate declared INI key",
                ));
            }
            found = Some(ini_scalar(value, setting)?);
        }
    }
    Ok(found)
}

pub(crate) fn read(file: &GameSettingsFile, bytes: &[u8]) -> Result<Vec<Option<Value>>> {
    validate_file_declaration(file)?;
    let text = text(file, bytes)?;
    let document = if file.format == GameSettingsFormat::Json {
        Some(json_document(text)?)
    } else {
        None
    };
    file.settings
        .iter()
        .map(|setting| {
            let value = match &document {
                Some(document) => json_value(document, &setting.key)?,
                None => ini_value(text, setting)?,
            };
            if let Some(value) = &value
                && !setting.value.accepts(value)
            {
                return Err(invalid(
                    "configuration setting is outside its declared type or range",
                ));
            }
            Ok(value)
        })
        .collect()
}

/// Replace one explicitly declared key. Unknown JSON data survives; INI bytes,
/// comments and line endings outside that key survive exactly. File I/O and
/// preimage review belong to the service, not this byte transformation.
pub(crate) fn edit(
    file: &GameSettingsFile,
    bytes: &[u8],
    setting_id: &str,
    value: &Value,
) -> Result<Vec<u8>> {
    let setting = file
        .settings
        .iter()
        .find(|setting| setting.id == setting_id)
        .ok_or_else(|| invalid("setting is absent from the retained descriptor"))?;
    if !setting.value.accepts(value) {
        return Err(invalid(
            "proposed value is outside its declared type or range",
        ));
    }
    // JSON numbers arriving through JavaScript may use an integer token for a
    // numeric control. Preserve the declared consumer type in the output.
    let encoded_value = if matches!(setting.value, GameSettingType::Number { .. }) {
        Value::from(value.as_f64().expect("validated number"))
    } else {
        value.clone()
    };
    read(file, bytes)?;
    let text = text(file, bytes)?;
    let output = match file.format {
        GameSettingsFormat::Json => {
            let mut document = json_document(text)?;
            let mut parent = &mut document;
            let (leaf, parents) = setting
                .key
                .split_last()
                .ok_or_else(|| invalid("missing setting key"))?;
            for component in parents {
                let object = parent
                    .as_object_mut()
                    .ok_or_else(|| invalid("configuration setting parent is not an object"))?;
                parent = object
                    .entry(component.clone())
                    .or_insert_with(|| serde_json::json!({}));
            }
            parent
                .as_object_mut()
                .ok_or_else(|| invalid("configuration setting parent is not an object"))?
                .insert(leaf.clone(), encoded_value.clone());
            let mut bytes = serde_json::to_vec_pretty(&document)?;
            bytes.push(b'\n');
            bytes
        }
        GameSettingsFormat::Ini => {
            let key = &setting.key[0];
            let replacement = scalar_text(&encoded_value)?;
            let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
            let mut output = String::new();
            let mut replaced = false;
            for line in text.split_inclusive('\n') {
                if ini_line(line).is_some_and(|(name, _)| name == key) {
                    let ending = if line.ends_with("\r\n") {
                        "\r\n"
                    } else if line.ends_with('\n') {
                        "\n"
                    } else {
                        ""
                    };
                    output.push_str(&format!("{key}={replacement}{ending}"));
                    replaced = true;
                } else {
                    output.push_str(line);
                }
            }
            if !replaced {
                if !output.is_empty() && !output.ends_with('\n') {
                    output.push_str(newline);
                }
                output.push_str(&format!("{key}={replacement}{newline}"));
            }
            output.into_bytes()
        }
    };
    if output.len() as u64 > file.maximum_bytes {
        return Err(invalid(
            "proposed configuration exceeds its retained size limit",
        ));
    }
    // Encoding and reading must agree before any service can publish bytes.
    let values = read(file, &output)?;
    let index = file
        .settings
        .iter()
        .position(|item| item.id == setting_id)
        .unwrap();
    if values[index].as_ref() != Some(&encoded_value) {
        return Err(invalid(
            "setting did not round-trip through its declared format",
        ));
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn declared(id: &str) -> GameSettingsFile {
        crate::Catalog::embedded()
            .unwrap()
            .port(id)
            .unwrap()
            .game_settings
            .as_ref()
            .unwrap()
            .files[0]
            .clone()
    }

    #[test]
    fn ship_json_integer_edit_and_reset_preserve_unknown_values() {
        let file = declared("shipwright");
        let before = br#"{"CVars":{"gSettings":{"Volume":{"Master":40},"Other":[null,1,"player"]}},"unknown":{"nested":true}}"#;
        let changed = edit(&file, before, &file.settings[0].id, &json!(70)).unwrap();
        let parsed: Value = serde_json::from_slice(&changed).unwrap();
        assert_eq!(parsed["CVars"]["gSettings"]["Volume"]["Master"], json!(70));
        assert!(
            parsed["CVars"]["gSettings"]["Volume"]["Master"]
                .as_i64()
                .is_some()
        );
        assert_eq!(
            parsed["CVars"]["gSettings"]["Other"],
            json!([null, 1, "player"])
        );
        assert_eq!(parsed["unknown"], json!({"nested":true}));
        let reset = edit(
            &file,
            &changed,
            &file.settings[0].id,
            &file.settings[0].value.default_value(),
        )
        .unwrap();
        assert_eq!(read(&file, &reset).unwrap(), vec![Some(json!(40))]);
        assert!(edit(&file, before, &file.settings[0].id, &json!(70.0)).is_err());
        assert!(edit(&file, before, "unknown-key", &json!(70)).is_err());
        assert!(edit(&file, before, &file.settings[0].id, &json!(101)).is_err());
    }

    #[test]
    fn ship_json_refuses_duplicates_dotted_aliases_and_nonobject_parents() {
        let file = declared("shipwright");
        for before in [
            br#"{"unknown":1,"unknown":2}"#.as_slice(),
            br#"{"CVars":{"gSettings.Volume.Master":40}}"#,
            br#"{"CVars":{"gSettings":{"Volume":{"Master":40}},"gSettings.Volume.Master":40}}"#,
            br#"{"CVars":false}"#,
            b"[]",
            b"\xff",
        ] {
            assert!(read(&file, before).is_err(), "{before:?}");
            assert!(edit(&file, before, &file.settings[0].id, &json!(50)).is_err());
        }
        assert_eq!(read(&file, b"{}").unwrap(), vec![None]);
        assert_eq!(
            read(
                &file,
                &edit(&file, b"{}", &file.settings[0].id, &json!(50)).unwrap()
            )
            .unwrap(),
            vec![Some(json!(50))]
        );
    }

    #[test]
    fn golden_ini_edit_and_reset_preserve_every_unrelated_byte_and_comment() {
        let file = declared("diddy-kong-racing-golden-balloon");
        let before = b"# Player preferences\r\nunknown=value=with=equals\nui_scale=1.00\r\n# trailing comment\r\nother=unchanged";
        let changed = edit(&file, before, &file.settings[0].id, &json!(1.25)).unwrap();
        assert_eq!(changed, b"# Player preferences\r\nunknown=value=with=equals\nui_scale=1.25\r\n# trailing comment\r\nother=unchanged");
        let reset = edit(
            &file,
            &changed,
            &file.settings[0].id,
            &file.settings[0].value.default_value(),
        )
        .unwrap();
        assert_eq!(reset, b"# Player preferences\r\nunknown=value=with=equals\nui_scale=1.0\r\n# trailing comment\r\nother=unchanged");
        assert_eq!(read(&file, &reset).unwrap(), vec![Some(json!(1.0))]);
        assert_eq!(
            read(&file, b"UI_SCALE=1.25\n ui_scale=1.5\n").unwrap(),
            vec![None]
        );
    }

    #[test]
    fn ini_ambiguous_values_and_size_refuse_without_modifying_input() {
        let mut file = declared("diddy-kong-racing-golden-balloon");
        for before in [
            b"ui_scale=1\nui_scale=1.25\n".as_slice(),
            b"ui_scale=NaN",
            b"ui_scale=99",
            b"ui_scale=1.23",
            b"ui_scale=1.0\\n",
        ] {
            let retained = before.to_vec();
            assert!(edit(&file, before, &file.settings[0].id, &json!(1.25)).is_err());
            assert_eq!(before, retained);
        }
        let added = edit(&file, b"# only comment", &file.settings[0].id, &json!(1.25)).unwrap();
        assert_eq!(added, b"# only comment\nui_scale=1.25\n");
        file.maximum_bytes = 2;
        assert!(read(&file, b"123").is_err());
        assert!(edit(&file, b"", &file.settings[0].id, &json!(1.25)).is_err());
    }

    #[test]
    fn consumer_rejected_ini_documents_are_not_presented_as_consumed_settings() {
        let file = declared("diddy-kong-racing-golden-balloon");
        for mut bytes in [
            b"unknown=hidden\0data\n".to_vec(),
            vec![b'#'; 384 * 1024 + 1],
        ] {
            bytes.extend_from_slice(b"\nui_scale=1.25\n");
            assert!(read(&file, &bytes).is_err());
            assert!(edit(&file, &bytes, &file.settings[0].id, &json!(1.5)).is_err());
        }
        let mut boundary = vec![b'#'; 384 * 1024];
        boundary.extend_from_slice(b"\nui_scale=1.25\n");
        assert_eq!(read(&file, &boundary).unwrap(), vec![Some(json!(1.25))]);
        assert_eq!(
            read(
                &file,
                &edit(&file, b"ui_scale=1.25", &file.settings[0].id, &json!(1)).unwrap()
            )
            .unwrap(),
            vec![Some(json!(1.0))]
        );
    }

    #[test]
    fn consumer_color_leaf_ancestors_refuse_json_settings_traversal() {
        let file = declared("shipwright");
        for tag in ["RGB", "RGBA"] {
            for parent in ["gSettings", "Volume"] {
                let mut value = json!({"CVars":{"gSettings":{"Volume":{"Master":40}}}});
                let target = if parent == "gSettings" {
                    &mut value["CVars"]["gSettings"]
                } else {
                    &mut value["CVars"]["gSettings"]["Volume"]
                };
                target
                    .as_object_mut()
                    .unwrap()
                    .insert("Type".into(), json!(tag));
                let bytes = serde_json::to_vec(&value).unwrap();
                assert!(read(&file, &bytes).is_err());
                assert!(edit(&file, &bytes, &file.settings[0].id, &json!(70)).is_err());
            }
        }
    }

    #[test]
    fn ini_declaration_refuses_ambiguous_or_escaped_enum_choices() {
        let mut file = declared("diddy-kong-racing-golden-balloon");
        for values in [
            vec![json!(1), json!("1")],
            vec![json!(true), json!("true")],
            vec![json!("bad\\n")],
        ] {
            file.settings[0].value = GameSettingType::Enum {
                choices: values
                    .iter()
                    .map(|value| super::super::GameSettingChoice {
                        label: "Choice".into(),
                        value: value.clone(),
                    })
                    .collect(),
                default: values[0].clone(),
            };
            assert!(validate_file_declaration(&file).is_err());
            assert!(read(&file, b"ui_scale=1").is_err());
            assert!(edit(&file, b"ui_scale=1", &file.settings[0].id, &values[0]).is_err());
        }
    }
}
