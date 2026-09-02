use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub type Result<T> = std::result::Result<T, PortcoveError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    Usage,
    Unsupported,
    NotFound,
    SourceInvalid,
    Network,
    Verification,
    Install,
    State,
    Launch,
    Conflict,
}

#[derive(Debug, Error)]
#[error("{message}")]
pub struct PortcoveError {
    pub code: ErrorCode,
    pub message: String,
    pub details: BTreeMap<String, String>,
}

impl PortcoveError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            details: BTreeMap::new(),
        }
    }

    pub fn detail(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.details.insert(key.into(), value.into());
        self
    }

    pub fn usage(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Usage, message)
    }
    pub fn unsupported(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Unsupported, message)
    }
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::NotFound, message)
    }
    pub fn source(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::SourceInvalid, message)
    }
    pub fn network(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Network, message)
    }
    pub fn verification(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Verification, message)
    }
    pub fn install(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Install, message)
    }
    pub fn state(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::State, message)
    }
    pub fn launch(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Launch, message)
    }
    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Conflict, message)
    }
}

impl From<std::io::Error> for PortcoveError {
    fn from(error: std::io::Error) -> Self {
        Self::state(error.to_string())
    }
}

impl From<rusqlite::Error> for PortcoveError {
    fn from(error: rusqlite::Error) -> Self {
        Self::state(error.to_string())
    }
}

impl From<serde_json::Error> for PortcoveError {
    fn from(error: serde_json::Error) -> Self {
        Self::state(error.to_string())
    }
}
