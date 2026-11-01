//! Version-bound game configuration declarations. Declarations do not grant
//! installation, filesystem, execution or definition-admission authority.

use std::collections::BTreeSet;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{Platform, PortcoveError, Result};

pub(crate) mod document;
mod service_types;
pub use service_types::*;

pub(crate) const MAX_SETTINGS_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GameSettingsContract {
    pub format_version: u32,
    pub releases: Vec<GameSettingsRelease>,
    pub files: Vec<GameSettingsFile>,
}

/// Both the released archive and its inspected source are explicit. A matching
/// title or version string alone cannot qualify another package's settings.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GameSettingsRelease {
    pub version: String,
    pub platform: Platform,
    pub archive_sha256: String,
    pub source_commit: String,
    pub evidence_urls: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GameSettingsFile {
    pub id: String,
    /// An explicit configuration file inside this port's retained persistent
    /// paths, never a home-directory template or a caller-provided absolute path.
    pub path: String,
    pub format: GameSettingsFormat,
    pub maximum_bytes: u64,
    pub settings: Vec<GameSetting>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum GameSettingsFormat {
    Json,
    /// Version one is the case-sensitive, flat key=value preference grammar.
    /// Sections, escapes and broader INI dialects are not inferred.
    Ini,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GameSetting {
    pub id: String,
    pub label: String,
    /// JSON object member components; flat INI uses exactly one literal key.
    /// No array indexing, wildcards, substitutions or executable expressions.
    pub key: Vec<String>,
    pub value: GameSettingType,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum GameSettingType {
    Boolean {
        default: bool,
    },
    Integer {
        minimum: i64,
        maximum: i64,
        step: i64,
        default: i64,
    },
    Number {
        minimum: f64,
        maximum: f64,
        step: f64,
        default: f64,
    },
    Enum {
        choices: Vec<GameSettingChoice>,
        default: Value,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GameSettingChoice {
    pub label: String,
    pub value: Value,
}

fn declaration_error(field: &str, message: &str) -> PortcoveError {
    PortcoveError::usage(message).detail("author_field", field)
}

fn text(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

fn identifier(value: &str) -> bool {
    text(value, 64)
        && value.split('-').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        })
}

fn digest(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn scalar(value: &Value) -> bool {
    match value {
        Value::Bool(_) => true,
        Value::Number(number) => number
            .as_i64()
            .is_some_and(|number| number.unsigned_abs() <= 1_000_000_000),
        Value::String(value) => value.len() <= 128 && !value.chars().any(char::is_control),
        _ => false,
    }
}

impl GameSettingType {
    pub fn default_value(&self) -> Value {
        match self {
            Self::Boolean { default } => Value::Bool(*default),
            Self::Integer { default, .. } => Value::from(*default),
            Self::Number { default, .. } => Value::from(*default),
            Self::Enum { default, .. } => default.clone(),
        }
    }

    pub fn accepts(&self, value: &Value) -> bool {
        match self {
            Self::Boolean { .. } => value.is_boolean(),
            Self::Integer {
                minimum,
                maximum,
                step,
                ..
            } => value.as_i64().is_some_and(|number| {
                *step > 0
                    && number >= *minimum
                    && number <= *maximum
                    && number
                        .checked_sub(*minimum)
                        .is_some_and(|difference| difference % step == 0)
            }),
            Self::Number {
                minimum,
                maximum,
                step,
                ..
            } => value.as_f64().is_some_and(|number| {
                if !number.is_finite()
                    || !minimum.is_finite()
                    || !maximum.is_finite()
                    || !step.is_finite()
                    || *step <= 0.0
                    || number < *minimum
                    || number > *maximum
                {
                    return false;
                }
                let steps = (number - minimum) / step;
                (steps - steps.round()).abs() <= 1e-8
            }),
            Self::Enum { choices, .. } => choices.iter().any(|choice| choice.value == *value),
        }
    }

    fn validate(&self, field: &str) -> Result<()> {
        match self {
            Self::Integer {
                minimum,
                maximum,
                step,
                ..
            } if minimum > maximum
                || minimum.unsigned_abs() > 1_000_000_000
                || maximum.unsigned_abs() > 1_000_000_000
                || *step <= 0
                || *step > 1_000_000_000 =>
            {
                return Err(declaration_error(
                    field,
                    "settings integer range or step is invalid",
                ));
            }
            Self::Number {
                minimum,
                maximum,
                step,
                ..
            } if !minimum.is_finite()
                || !maximum.is_finite()
                || !step.is_finite()
                || minimum > maximum
                || minimum.abs() > 1_000_000_000.0
                || maximum.abs() > 1_000_000_000.0
                || *step < 0.000_001
                || *step > (maximum - minimum).max(1.0) =>
            {
                return Err(declaration_error(
                    field,
                    "settings numeric range or step is invalid",
                ));
            }
            Self::Enum { choices, .. } => {
                if choices.is_empty() || choices.len() > 32 {
                    return Err(declaration_error(
                        field,
                        "settings choices require one to 32 entries",
                    ));
                }
                let mut values = BTreeSet::new();
                for choice in choices {
                    if !text(&choice.label, 128)
                        || !scalar(&choice.value)
                        || !values.insert(serde_json::to_string(&choice.value)?)
                    {
                        return Err(declaration_error(
                            field,
                            "settings choice is invalid or duplicated",
                        ));
                    }
                }
            }
            _ => {}
        }
        if !self.accepts(&self.default_value()) {
            return Err(declaration_error(
                field,
                "settings default is outside its declared choices",
            ));
        }
        Ok(())
    }
}

impl GameSettingsContract {
    /// Validate declaration shape only. The service must separately establish
    /// accepted retained authority, exact installation and safe current storage.
    pub fn validate(&self, persistent_paths: &[String]) -> Result<()> {
        if self.format_version != 1 {
            return Err(declaration_error(
                "game_settings.format_version",
                "unsupported settings contract version",
            ));
        }
        if self.releases.is_empty() || self.releases.len() > 16 {
            return Err(declaration_error(
                "game_settings.releases",
                "settings require one to 16 qualified releases",
            ));
        }
        let mut releases = BTreeSet::new();
        for release in &self.releases {
            if release.platform != Platform::WindowsX86_64
                || !text(&release.version, 128)
                || !digest(&release.archive_sha256, 64)
                || !digest(&release.source_commit, 40)
                || release.evidence_urls.is_empty()
                || release.evidence_urls.len() > 8
                || release.evidence_urls.iter().any(|url| {
                    !text(url, 2048)
                        || !reqwest::Url::parse(url).is_ok_and(|url| {
                            url.scheme() == "https"
                                && url.host_str().is_some()
                                && url.username().is_empty()
                                && url.password().is_none()
                        })
                })
                || !releases.insert((release.version.as_str(), release.archive_sha256.as_str()))
            {
                return Err(declaration_error(
                    "game_settings.releases",
                    "settings release requires exact Windows package/source identities and evidence",
                ));
            }
        }
        if self.files.is_empty() || self.files.len() > 8 {
            return Err(declaration_error(
                "game_settings.files",
                "settings require one to eight configuration files",
            ));
        }
        let mut files = BTreeSet::new();
        let mut file_ids = BTreeSet::new();
        let mut ids = BTreeSet::new();
        let mut count = 0;
        for file in &self.files {
            crate::archive::validate_relative_path(&file.path, false)?;
            let suffix = match file.format {
                GameSettingsFormat::Json => ".json",
                GameSettingsFormat::Ini => ".ini",
            };
            if !identifier(&file.id)
                || !file_ids.insert(&file.id)
                || file.path.len() > 512
                || file.path.contains(['\\', ':'])
                || file
                    .path
                    .split('/')
                    .any(|component| component.ends_with(['.', ' ']))
                || !file.path.to_ascii_lowercase().ends_with(suffix)
                || !files.insert(file.path.to_ascii_lowercase())
                || file.maximum_bytes == 0
                || file.maximum_bytes > MAX_SETTINGS_BYTES
                || !persistent_paths
                    .iter()
                    .any(|path| file.path == *path || file.path.starts_with(&format!("{path}/")))
            {
                return Err(declaration_error(
                    "game_settings.files",
                    "settings target must be an explicit bounded persistent configuration file",
                ));
            }
            if file.settings.is_empty() {
                return Err(declaration_error(
                    "game_settings.files.settings",
                    "a configuration file requires editable settings",
                ));
            }
            let mut keys = BTreeSet::new();
            for setting in &file.settings {
                count += 1;
                if count > 32
                    || !identifier(&setting.id)
                    || !ids.insert(&setting.id)
                    || !text(&setting.label, 128)
                    || setting.key.is_empty()
                    || setting.key.len()
                        > if file.format == GameSettingsFormat::Ini {
                            1
                        } else {
                            8
                        }
                    || setting.key.iter().any(|key| {
                        key.is_empty()
                            || key.len() > 128
                            || !key
                                .bytes()
                                .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
                    })
                    || keys.iter().any(|key: &Vec<String>| {
                        key.starts_with(&setting.key) || setting.key.starts_with(key)
                    })
                    || !keys.insert(setting.key.clone())
                {
                    return Err(declaration_error(
                        "game_settings.files.settings",
                        "settings need unique bounded ids and literal object/INI keys",
                    ));
                }
                setting
                    .value
                    .validate(&format!("game_settings.settings.{}", setting.id))?;
            }
            document::validate_file_declaration(file)?;
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "game_settings_tests.rs"]
mod tests;
