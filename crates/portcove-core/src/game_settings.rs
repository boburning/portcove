//! Version-bound game configuration declarations. Declarations do not grant
//! installation, filesystem, execution or definition-admission authority.

use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::{Platform, PortcoveError, Result};

pub(crate) mod document;
mod qualification;
pub use qualification::inspect_game_settings_qualification;
mod service_types;
#[cfg(windows)]
pub(crate) mod windows;
pub use service_types::*;

pub(crate) const MAX_SETTINGS_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ShippedDefault {
    sha256: String,
    // Hex keeps the serialized size bounded at twice the declared byte limit.
    // The exact bytes may be needed after ordinary persistence overwrites the
    // staged runtime's copy or the original archive leaves the download cache.
    bytes_hex: String,
}

impl ShippedDefault {
    pub(crate) fn verified_bytes(&self, file: &GameSettingsFile) -> Result<Vec<u8>> {
        if (self.bytes_hex.len() as u64) > 2 * file.maximum_bytes.min(MAX_SETTINGS_BYTES) {
            return Err(PortcoveError::verification(
                "retained package settings default exceeds the declared file limit",
            ));
        }
        let bytes = hex::decode(&self.bytes_hex).map_err(|_| {
            PortcoveError::verification("retained package settings default is malformed")
        })?;
        if hex::encode(Sha256::digest(&bytes)) != self.sha256 {
            return Err(PortcoveError::verification(
                "retained package settings default differs from its recorded digest",
            ));
        }
        document::read(file, &bytes)?;
        Ok(bytes)
    }
}

/// The persistence owner must provide a deletion receipt. Filesystem absence
/// alone leaves the live state unobserved.
#[derive(Clone, Copy)]
pub(crate) enum PlayerSettings<'a> {
    Present(&'a [u8]),
    RecordedDeletion,
    Unobserved,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SettingsUpdate {
    KeepPlayer,
    InstallDefault(Vec<u8>),
    KeepPlayerAndDefault(Vec<u8>),
    MissingBaseline { incoming_default: Option<Vec<u8>> },
    MissingPlayerEvidence(Vec<u8>),
}

/// Plan the raw-file transition before any publication. The lifecycle owner
/// must recheck the same player preimage and retain both versions on conflict.
pub(crate) fn reconcile_shipped_default(
    file: &GameSettingsFile,
    old: Option<(&GameSettingsFile, &ShippedDefault)>,
    player: PlayerSettings<'_>,
    incoming: Option<&ShippedDefault>,
) -> Result<SettingsUpdate> {
    let incoming = incoming
        .map(|value| value.verified_bytes(file))
        .transpose()?;
    let Some((old_file, old)) = old else {
        return Ok(SettingsUpdate::MissingBaseline {
            incoming_default: incoming,
        });
    };
    let Some(incoming) = incoming else {
        return Ok(SettingsUpdate::MissingBaseline {
            incoming_default: None,
        });
    };
    // The earlier default was verified against its own retained declaration.
    // A newer range or enumeration can legitimately exclude an older value.
    let old = old.verified_bytes(old_file)?;
    if old == incoming {
        return Ok(SettingsUpdate::KeepPlayer);
    }
    Ok(match player {
        PlayerSettings::Present(player) if player == incoming.as_slice() => {
            SettingsUpdate::KeepPlayer
        }
        PlayerSettings::Present(player) if player == old.as_slice() => {
            SettingsUpdate::InstallDefault(incoming)
        }
        PlayerSettings::Present(_) | PlayerSettings::RecordedDeletion => {
            SettingsUpdate::KeepPlayerAndDefault(incoming)
        }
        PlayerSettings::Unobserved => SettingsUpdate::MissingPlayerEvidence(incoming),
    })
}

pub(crate) struct SettingsFileUpdate {
    pub path: String,
    pub player_preimage: SettingsPreimage,
    pub update: SettingsUpdate,
    file_id: String,
    format: GameSettingsFormat,
}

/// An expected absent file has different authority from an unobserved file.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SettingsPreimage {
    Present { sha256: String },
    RecordedDeletion,
    Unobserved,
}

/// Read one settings copy at a previously authorized persistence root. A
/// missing coordinate is observable, but does not by itself establish deletion.
pub(crate) fn observe_player_settings_copy(
    root: &Path,
    file: &GameSettingsFile,
) -> Result<Option<Vec<u8>>> {
    crate::archive::validate_relative_path(&file.path, false)?;
    let path = root.join(&file.path);
    crate::path::refuse_symlink_ancestors(&path)?;
    match fs::symlink_metadata(&path) {
        Ok(_) => crate::external_runtime::read_single_link_metadata(
            &path,
            file.maximum_bytes.min(MAX_SETTINGS_BYTES),
        )
        .map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            crate::persistence::require_absent_path(root, &file.path)?;
            Ok(None)
        }
        Err(error) => Err(error.into()),
    }
}

impl SettingsFileUpdate {
    /// Recheck the planned player bytes immediately before a transaction takes
    /// custody. The old active mirror must still agree with canonical data.
    /// Absence only matches an already recorded deletion; it never grants one.
    pub(crate) fn require_unchanged_player(
        &self,
        file: &GameSettingsFile,
        canonical_root: &Path,
        active_mirror: Option<&Path>,
    ) -> Result<()> {
        if self.path != file.path || self.file_id != file.id || self.format != file.format {
            return Err(PortcoveError::verification(
                "the settings update differs from its declared file identity",
            ));
        }
        let current = observe_player_settings_copy(canonical_root, file)?;
        if let Some(root) = active_mirror
            && observe_player_settings_copy(root, file)? != current
        {
            return Err(PortcoveError::conflict(
                "the active and canonical settings files differ; preserve both before changing versions",
            )
            .detail("settings_file", &self.path));
        }
        let matches = match (&self.player_preimage, current.as_deref()) {
            (SettingsPreimage::Present { sha256 }, Some(bytes)) => {
                hex::encode(Sha256::digest(bytes)) == *sha256
            }
            (SettingsPreimage::RecordedDeletion, None) => true,
            _ => false,
        };
        if !matches {
            return Err(PortcoveError::conflict(
                "the player's settings changed or lack a verified preimage; review this installation again",
            )
            .detail("settings_file", &self.path));
        }
        Ok(())
    }
}

pub(crate) struct RetainedSettingsDefaults {
    pub contract: GameSettingsContract,
    pub shipped: BTreeMap<String, ShippedDefault>,
    pub capture_gaps: BTreeMap<String, ShippedDefaultGap>,
}

impl RetainedSettingsDefaults {
    /// Compare incoming declared settings with the prior retained package.
    /// The caller supplies the persistence owner's coherent file observations.
    pub(crate) fn plan_update(
        &self,
        prior: Option<&Self>,
        player: &BTreeMap<String, PlayerSettings<'_>>,
    ) -> Result<Vec<SettingsFileUpdate>> {
        let mut updates = Vec::new();
        for file in &self.contract.files {
            let incoming = self.shipped.get(&file.path);
            let old = prior.and_then(|prior| {
                let old_file = prior.contract.files.iter().find(|old| {
                    old.id == file.id && old.path == file.path && old.format == file.format
                })?;
                Some((old_file, prior.shipped.get(&file.path)?))
            });
            if incoming.is_none() && old.is_none() {
                continue;
            }
            let player = player
                .get(&file.path)
                .copied()
                .unwrap_or(PlayerSettings::Unobserved);
            let player_preimage = match player {
                PlayerSettings::Present(bytes) => {
                    if bytes.len() as u64 > MAX_SETTINGS_BYTES {
                        return Err(PortcoveError::verification(
                            "player settings exceed the reconciliation file limit",
                        ));
                    }
                    SettingsPreimage::Present {
                        sha256: hex::encode(Sha256::digest(bytes)),
                    }
                }
                PlayerSettings::RecordedDeletion => SettingsPreimage::RecordedDeletion,
                PlayerSettings::Unobserved => SettingsPreimage::Unobserved,
            };
            updates.push(SettingsFileUpdate {
                path: file.path.clone(),
                player_preimage,
                update: reconcile_shipped_default(file, old, player, incoming)?,
                file_id: file.id.clone(),
                format: file.format,
            });
        }
        Ok(updates)
    }
}

/// Only the verified package's pristine private extraction may supply these
/// defaults. Missing or unreadable files provide no baseline.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ShippedDefaultGap {
    Omitted,
    Unreadable,
    Malformed,
}

impl ShippedDefaultGap {
    pub(crate) fn hold_reason(self) -> Option<&'static str> {
        match self {
            Self::Omitted => None,
            Self::Unreadable => Some("unreadable-package-default"),
            Self::Malformed => Some("malformed-package-default"),
        }
    }
}

#[derive(Default)]
pub(crate) struct ShippedDefaultCapture {
    pub defaults: BTreeMap<String, ShippedDefault>,
    pub gaps: BTreeMap<String, ShippedDefaultGap>,
}

#[cfg(test)]
pub(crate) fn capture_shipped_defaults(
    port: &crate::PortDefinition,
    platform: Platform,
    version: &str,
    archive_sha256: &str,
    persistence_root: &Path,
) -> BTreeMap<String, ShippedDefault> {
    capture_shipped_settings(port, platform, version, archive_sha256, persistence_root).defaults
}

pub(crate) fn capture_shipped_settings(
    port: &crate::PortDefinition,
    platform: Platform,
    version: &str,
    archive_sha256: &str,
    persistence_root: &Path,
) -> ShippedDefaultCapture {
    let Some(contract) = port.game_settings.as_ref() else {
        return ShippedDefaultCapture::default();
    };
    if contract.validate(&port.persistent_paths).is_err() {
        return ShippedDefaultCapture::default();
    }
    if !contract.covers_archive(platform, version, archive_sha256) {
        return ShippedDefaultCapture::default();
    }
    let mut captured = ShippedDefaultCapture::default();
    for file in &contract.files {
        let bytes = match observe_player_settings_copy(persistence_root, file) {
            Ok(Some(bytes)) => bytes,
            Ok(None) => {
                captured
                    .gaps
                    .insert(file.path.clone(), ShippedDefaultGap::Omitted);
                continue;
            }
            Err(_) => {
                captured
                    .gaps
                    .insert(file.path.clone(), ShippedDefaultGap::Unreadable);
                continue;
            }
        };
        if document::read(file, &bytes).is_err() {
            captured
                .gaps
                .insert(file.path.clone(), ShippedDefaultGap::Malformed);
            continue;
        }
        captured.defaults.insert(
            file.path.clone(),
            ShippedDefault {
                sha256: hex::encode(Sha256::digest(&bytes)),
                bytes_hex: hex::encode(bytes),
            },
        );
    }
    captured
}

/// Reopened installs must still bind the preserved defaults to the exact
/// artifact and file declarations retained at acquisition.
pub(crate) fn verify_shipped_defaults(
    port: &crate::PortDefinition,
    platform: Platform,
    version: &str,
    archive_sha256: &str,
    defaults: &BTreeMap<String, ShippedDefault>,
    gaps: &BTreeMap<String, ShippedDefaultGap>,
) -> Result<()> {
    if defaults.is_empty() && gaps.is_empty() {
        return Ok(());
    }
    let contract = port
        .game_settings
        .as_ref()
        .filter(|contract| contract.covers_archive(platform, version, archive_sha256))
        .ok_or_else(|| {
            PortcoveError::verification(
                "shipped settings defaults have no retained archive authority",
            )
        })?;
    contract.validate(&port.persistent_paths)?;
    if defaults.len() + gaps.len() > contract.files.len()
        || gaps.keys().any(|path| {
            defaults.contains_key(path) || !contract.files.iter().any(|file| &file.path == path)
        })
    {
        return Err(PortcoveError::verification(
            "shipped settings defaults exceed their retained file declarations",
        ));
    }
    for (path, default) in defaults {
        let file = contract
            .files
            .iter()
            .find(|file| &file.path == path)
            .ok_or_else(|| {
                PortcoveError::verification(
                    "shipped settings default has no retained file declaration",
                )
            })?;
        default.verified_bytes(file)?;
    }
    Ok(())
}

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
    /// One key component selects case-sensitive flat preferences; two select
    /// the bounded section/key grammar. Neither infers general INI dialects.
    Ini,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GameSetting {
    pub id: String,
    pub label: String,
    /// JSON object members; INI uses one flat key or two section/key components.
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
    pub(crate) fn covers_archive(
        &self,
        platform: Platform,
        version: &str,
        archive_sha256: &str,
    ) -> bool {
        self.releases.iter().any(|release| {
            release.platform == platform
                && release.version == version
                && release.archive_sha256 == archive_sha256
        })
    }

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
                || file.path.split('/').any(|component| {
                    component.ends_with(['.', ' '])
                        || component.to_ascii_lowercase().starts_with(".portcove")
                })
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
                            2
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
