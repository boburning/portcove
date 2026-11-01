use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::GameSettingType;

/// A missing optional capability is local to settings. It does not disable the
/// installation's independently assessed basic setup or launch capabilities.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct GameSettingsView {
    pub port_id: String,
    pub install_id: Option<String>,
    pub available: bool,
    pub reason: Option<String>,
    pub files: Vec<GameSettingsFileView>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct GameSettingsFileView {
    pub id: String,
    pub path: String,
    pub configuration_sha256: String,
    pub settings: Vec<GameSettingView>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct GameSettingView {
    pub id: String,
    pub label: String,
    pub value_type: GameSettingType,
    /// None means this declared key is absent; the verified consumer default
    /// remains separate from an observed persisted value.
    pub value: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "action", rename_all = "kebab-case", deny_unknown_fields)]
pub enum GameSettingChange {
    Set { value: Value },
    Reset,
}

/// One-file, one-key review. Apply recomputes this binding from authoritative
/// retained state and fresh bytes; a client-supplied review is never authority.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct GameSettingReview {
    pub port_id: String,
    pub install_id: String,
    pub file_id: String,
    pub setting_id: String,
    pub label: String,
    pub path: String,
    pub change: GameSettingChange,
    pub previous_value: Option<Value>,
    pub proposed_value: Value,
    pub configuration_sha256: String,
    pub review_sha256: String,
}
