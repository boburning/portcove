//! Inert authoring probe. This uses the production document editor without
//! opening a library or conferring filesystem, package or publication authority.

use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::{
    GameSettingType, GameSettingsContract, GameSettingsFormat, GameSettingsRelease, document,
};
use crate::{PortcoveError, Result, definition_entry::strict_json::UniqueValue};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    format_version: u32,
    contract: GameSettingsContract,
    persistent_paths: Vec<String>,
    candidate: GameSettingsRelease,
    samples: Vec<Sample>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Sample {
    file_id: String,
    document: String,
}

fn invalid(message: &str) -> PortcoveError {
    PortcoveError::usage(message)
}

fn values(kind: &GameSettingType) -> Vec<Value> {
    let mut values = vec![kind.default_value()];
    match kind {
        GameSettingType::Boolean { .. } => values.extend([json!(false), json!(true)]),
        GameSettingType::Integer {
            minimum,
            maximum,
            step,
            ..
        } => {
            values.push(json!(minimum));
            values.push(json!(maximum - (maximum - minimum) % step));
        }
        GameSettingType::Number {
            minimum,
            maximum,
            step,
            ..
        } => {
            values.push(json!(minimum));
            values.push(json!(minimum + ((maximum - minimum) / step).floor() * step));
        }
        GameSettingType::Enum { choices, .. } => {
            values.extend(choices.iter().map(|choice| choice.value.clone()));
        }
    }
    values.dedup();
    values
}

// Compare every member outside the one declared object path, including newly
// created parent objects. This oracle does not call the editor or derive its
// expected structure from an edited result.
fn preserves_json(before: Option<&Value>, after: Option<&Value>, key: &[String]) -> bool {
    if key.is_empty() {
        return true;
    }
    match (
        before.and_then(Value::as_object),
        after.and_then(Value::as_object),
    ) {
        (before, Some(after)) => {
            let part = &key[0];
            before
                .into_iter()
                .flat_map(|object| object.keys())
                .chain(after.keys())
                .all(|name| {
                    let old = before.and_then(|object| object.get(name));
                    let new = after.get(name);
                    if name == part {
                        preserves_json(old, new, &key[1..])
                    } else {
                        old == new
                    }
                })
        }
        _ => false,
    }
}

/// Validate/read/edit/reset bounded configuration samples using the same
/// implementation as the settings service. Successful probes alone do not
/// establish upstream semantics, package integrity or retained write authority.
pub fn inspect_game_settings_qualification(bytes: &[u8]) -> Result<Value> {
    if bytes.len() > 4 * 1024 * 1024 {
        return Err(invalid("settings qualification input exceeds its bound"));
    }
    let UniqueValue(value) = serde_json::from_slice(bytes)?;
    let input: Input = serde_json::from_value(value)?;
    if input.format_version != 1 || input.samples.len() != input.contract.files.len() {
        return Err(invalid(
            "settings qualification needs one sample per declared file",
        ));
    }
    input.contract.validate(&input.persistent_paths)?;
    let mut candidate = input.contract.clone();
    candidate.releases = vec![input.candidate.clone()];
    candidate.validate(&input.persistent_paths)?;
    let mut checks = Vec::new();
    for file in &input.contract.files {
        if file.format != GameSettingsFormat::Json {
            return Err(invalid(
                "automatic settings qualification currently supports JSON contracts only; retain existing explicit INI qualification",
            ));
        }
        let matching: Vec<_> = input
            .samples
            .iter()
            .filter(|sample| sample.file_id == file.id)
            .collect();
        if matching.len() != 1 {
            return Err(invalid(
                "settings qualification sample is missing or ambiguous",
            ));
        }
        let bytes = matching[0].document.as_bytes();
        document::read(file, bytes)?;
        for (index, setting) in file.settings.iter().enumerate() {
            let mut tested = 0;
            let probe_values = values(&setting.value);
            for value in &probe_values {
                let edited = document::edit(file, bytes, &setting.id, value)?;
                let read = document::read(file, &edited)?;
                if read[index].as_ref() != Some(value) {
                    // Decimal tokens may be normalized to the declared numeric
                    // representation; compare the intended scalar, not its token.
                    let numeric = matches!(setting.value, GameSettingType::Number { .. })
                        && read[index].as_ref().and_then(Value::as_f64) == value.as_f64();
                    if !numeric {
                        return Err(invalid("settings qualification readback differs"));
                    }
                }
                if file.format == GameSettingsFormat::Json {
                    let before: Value = serde_json::from_slice(bytes)?;
                    let after: Value = serde_json::from_slice(&edited)?;
                    if !preserves_json(Some(&before), Some(&after), &setting.key) {
                        return Err(invalid(
                            "settings qualification changed unrelated JSON values",
                        ));
                    }
                }
                let reset =
                    document::edit(file, &edited, &setting.id, &setting.value.default_value())?;
                let reset_read = document::read(file, &reset)?;
                let expected = setting.value.default_value();
                let reset_matches = reset_read[index].as_ref() == Some(&expected)
                    || (matches!(setting.value, GameSettingType::Number { .. })
                        && reset_read[index].as_ref().and_then(Value::as_f64) == expected.as_f64());
                if !reset_matches || document::edit(file, bytes, &setting.id, &Value::Null).is_ok()
                {
                    return Err(invalid(
                        "settings qualification reset or invalid-value refusal differs",
                    ));
                }
                tested += 1;
            }
            checks.push(
                json!({"file_id": file.id, "setting_id": setting.id, "values_tested": tested, "values": probe_values}),
            );
        }
    }
    Ok(json!({
        "format_version": 1,
        "input_sha256": hex::encode(Sha256::digest(bytes)),
        "contract_sha256": hex::encode(Sha256::digest(serde_json::to_vec(&input.contract.files)?)),
        "binding": input.candidate,
        "checks": checks,
        "scope": "document-read-write-reset-validation-preservation; no upstream-consumer, filesystem, package or publication authority"
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> Value {
        let authored: Value =
            serde_json::from_str(include_str!("../../catalog/ports/shipwright.json")).unwrap();
        json!({
            "format_version": 1,
            "contract": authored["integration"]["game_settings"],
            "persistent_paths": authored["integration"]["persistent_paths"],
            "candidate": {
                "version": "future-compatible",
                "platform": "windows-x86-64",
                "archive_sha256": "a".repeat(64),
                "source_commit": "b".repeat(40),
                "evidence_urls": ["https://github.com/example/port/blob/exact/config.cpp"]
            },
            "samples": [{"file_id": "preferences", "document": "{\"CVars\":{\"gSettings\":{\"Volume\":{\"Master\":37,\"Other\":73}},\"other\":false},\"unknown\":{\"keep\":[1,true,\"text\"]}}"}]
        })
    }

    #[test]
    fn document_qualification_uses_actual_editor_and_preserves_unknown_values() {
        let input = serde_json::to_vec(&input()).unwrap();
        let report = inspect_game_settings_qualification(&input).unwrap();
        assert_eq!(report["checks"][0]["values_tested"], 3);
        assert_eq!(report["binding"]["version"], "future-compatible");
        assert_eq!(report["input_sha256"], hex::encode(Sha256::digest(&input)));
        assert!(preserves_json(
            Some(&json!({"known": {"value": 37, "other": true}})),
            Some(&json!({"known": {"value": 100, "other": true}})),
            &["known".into(), "value".into()]
        ));
        assert!(!preserves_json(
            Some(&json!({"known": {"value": 37, "other": true}})),
            Some(&json!({"known": {"value": 100, "other": false}})),
            &["known".into(), "value".into()]
        ));
    }

    #[test]
    fn document_qualification_refuses_ambiguous_missing_and_invalid_samples() {
        for document in [
            "{\"CVars\":{\"gSettings.Volume.Master\":37}}",
            "{\"CVars\":{\"gSettings\":{\"Volume\":{\"Master\":37,\"Master\":40}}}}",
            "{\"CVars\":{\"gSettings\":{\"Volume\":{\"Master\":\"37\"}}}}",
        ] {
            let mut value = input();
            value["samples"][0]["document"] = json!(document);
            assert!(
                inspect_game_settings_qualification(&serde_json::to_vec(&value).unwrap()).is_err()
            );
        }
        let mut value = input();
        value["samples"] = json!([]);
        assert!(inspect_game_settings_qualification(&serde_json::to_vec(&value).unwrap()).is_err());
        let mut value = input();
        value["candidate"]["platform"] = json!("linux-x86-64");
        assert!(inspect_game_settings_qualification(&serde_json::to_vec(&value).unwrap()).is_err());
        assert!(inspect_game_settings_qualification(&vec![b' '; 4 * 1024 * 1024 + 1]).is_err());
    }
}
