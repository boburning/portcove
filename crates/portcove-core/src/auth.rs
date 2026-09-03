use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{PortcoveError, Result};

const CREDENTIAL_SERVICE: &str = "io.github.portcove.Portcove";
const CREDENTIAL_USER: &str = "github.com";
// Public identity of github.com/apps/portcove. This is not a credential.
const DEFAULT_GITHUB_CLIENT_ID: &str = "Iv23liakfuffw2l9zB48";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum GithubAuthSource {
    Anonymous,
    Environment,
    CredentialStore,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct GithubRateLimit {
    pub limit: u64,
    pub remaining: u64,
    pub resets_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct GithubAuthStatus {
    pub source: GithubAuthSource,
    pub authenticated: bool,
    pub login: Option<String>,
    pub rate_limit: Option<GithubRateLimit>,
    pub device_login_available: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct GithubDeviceLogin {
    pub session_id: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_at: u64,
    pub interval_seconds: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum GithubDeviceLoginState {
    Pending,
    Complete,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct GithubDeviceLoginResult {
    pub state: GithubDeviceLoginState,
    pub status: Option<GithubAuthStatus>,
}

pub(crate) fn environment_token() -> Option<String> {
    ["PORTCOVE_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]
        .iter()
        .find_map(|name| {
            std::env::var(name)
                .ok()
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty())
        })
}

pub(crate) fn load_stored_token() -> Result<Option<String>> {
    let entry = credential_entry()?;
    match entry.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(credential_error("read", error)),
    }
}

pub(crate) fn store_token(token: &str) -> Result<()> {
    credential_entry()?
        .set_password(token)
        .map_err(|error| credential_error("write", error))
}

pub(crate) fn delete_stored_token() -> Result<bool> {
    match credential_entry()?.delete_credential() {
        Ok(()) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(error) => Err(credential_error("delete", error)),
    }
}

pub(crate) fn github_client_id() -> Option<String> {
    std::env::var("PORTCOVE_GITHUB_CLIENT_ID")
        .ok()
        .or_else(|| option_env!("PORTCOVE_GITHUB_CLIENT_ID").map(str::to_owned))
        .or_else(|| Some(DEFAULT_GITHUB_CLIENT_ID.to_owned()))
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn credential_entry() -> Result<keyring::Entry> {
    keyring::Entry::new(CREDENTIAL_SERVICE, CREDENTIAL_USER)
        .map_err(|error| credential_error("open", error))
}

fn credential_error(action: &str, error: keyring::Error) -> PortcoveError {
    PortcoveError::state(format!(
        "could not {action} the GitHub credential in operating-system secure storage: {error}"
    ))
}
