//! Provider-neutral, disposable observations of mod listings.
//!
//! Everything here is *untrusted presentation and candidate data*: it never grants
//! compatibility, trust or permission to acquire. Reviewed bindings and native
//! metadata decide whether a candidate may be planned; a provider's claims (names,
//! versions, checksums, scan results) only describe what it said and when.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub(crate) const MAX_TEXT_CHARS: usize = 256;

/// How current an observation is. A confirmed empty result is `Fresh`; an outage
/// that falls back to earlier data is `Stale`, never an empty list.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProviderFreshness {
    Fresh,
    /// The provider confirmed its cached copy is unchanged (HTTP 304).
    Revalidated,
    /// The provider could not be reached or is backing off; this is earlier data.
    Stale,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Observed<T> {
    pub value: T,
    /// Unix seconds when the provider data was last confirmed.
    pub observed_at: i64,
    pub freshness: ProviderFreshness,
}

/// A provider's own claims about one downloadable file. The checksum is the
/// provider's claim; an MD5 or any provider-supplied digest never authenticates
/// a publisher.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ProviderFileCandidate {
    /// Provider file identity; distinct from the project and from any version label.
    pub file_id: String,
    pub file_name: String,
    pub size: u64,
    pub added_at: i64,
    /// Canonical download location derived from `file_id`, never a provider-supplied URL.
    pub download_url: String,
    pub claimed_md5: Option<String>,
    pub archived: bool,
    /// Provider scan outcomes, as claimed ("clean", "infected", ...). Not an assurance.
    pub claimed_scan: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ProviderProject {
    pub provider: String,
    pub project_id: String,
    pub name: String,
    /// Displayed version label; it does not identify bytes (a file can change
    /// under an unchanged label).
    pub version: Option<String>,
    /// The provider's game identity for this project; compared against a reviewed
    /// binding, never matched by name or popularity.
    pub game_id: Option<String>,
    pub updated_at: i64,
    pub obsolete: bool,
    pub profile_url: String,
    pub submitter: Option<String>,
    pub files: Vec<ProviderFileCandidate>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ProviderPage {
    pub projects: Vec<ProviderProject>,
    pub total: u64,
    pub page: u32,
    /// False when more pages exist; callers must not treat a page as the whole result.
    pub complete: bool,
}

/// Provider text is presentation only: strip control and bidirectional-override
/// characters and bound its length so it cannot spoof or flood the interface.
pub(crate) fn sanitize_text(value: &str) -> String {
    value
        .chars()
        .filter(|c| {
            !c.is_control()
                && !matches!(*c, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{200E}' | '\u{200F}')
        })
        .take(MAX_TEXT_CHARS)
        .collect::<String>()
        .trim()
        .to_owned()
}

pub(crate) fn numeric_id(value: &serde_json::Value) -> Option<String> {
    let id = value.as_u64().filter(|id| *id > 0)?;
    Some(id.to_string())
}
