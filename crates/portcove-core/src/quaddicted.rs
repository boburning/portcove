//! Read-only Quaddicted v1 observations for reviewed Quake engines.
use std::collections::{BTreeMap, BTreeSet};

use reqwest::Url;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    AdapterKind, Observed, Platform, PortDefinition, PortcoveError, ReleaseSource, Result,
    mod_provider::sanitize_text, provider_http::ProviderHttp,
};

const API: &str = "https://www.quaddicted.com/api/v1/";
pub(crate) const DIRECTORY: &str = "https://www.quaddicted.com/db/v2/";
const MAP_PAGE: &str = "https://www.quaddicted.com/db/v2/maps/";
const FILTER: &str = "+tags:\"game=quake\" +tags:\"game_mode=singleplayer\"";
const PAGE_SIZE: usize = 24;
const MAX_PAGE: u32 = 20;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum QuakeEngine {
    VkQuake,
    Ironwail,
}

pub(crate) fn source(port: &PortDefinition, platform: Platform) -> Option<QuakeEngine> {
    if port.adapter != AdapterKind::NativePortable
        || port.release.provider != ReleaseSource::Github
        || !matches!(platform, Platform::WindowsX86_64 | Platform::LinuxX86_64)
        || !port.platforms.contains(&platform)
    {
        return None;
    }
    match (port.id.as_str(), port.release.repository.as_str()) {
        ("quake-vkquake", "Novum/vkQuake") => Some(QuakeEngine::VkQuake),
        ("quake-ironwail", "andrei-drexler/ironwail") => Some(QuakeEngine::Ironwail),
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum QuaddictedEngineCompatibility {
    Unverified,
    DeclaresAnotherRequiredEngine,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct QuaddictedInstallNotes {
    pub extract: Option<String>,
    pub extract_mapping: BTreeMap<String, String>,
    pub command_line: Vec<String>,
    pub start_maps: Vec<String>,
    pub dependencies: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct QuaddictedEntry {
    pub title: String,
    pub page_url: String,
    pub filename: Option<String>,
    pub authors: Vec<String>,
    pub release_date: Option<String>,
    /// Publisher metadata claim. This adapter never verifies or downloads bytes.
    pub claimed_sha256: String,
    pub claimed_bytes: Option<u64>,
    /// Exact provider-declared locations. These are display data.
    pub source_urls: Vec<String>,
    pub content_kind: Vec<String>,
    pub engine_requirements: Vec<String>,
    /// Provider notes, for text rendering only. May contain markup as literal text.
    pub provider_notes: Vec<String>,
    pub engine_compatibility: QuaddictedEngineCompatibility,
    /// Inert extraction/launch descriptions. Never interpreted by this adapter.
    pub install_notes: QuaddictedInstallNotes,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct QuaddictedPage {
    pub attribution: String,
    pub source_url: String,
    pub engine: QuakeEngine,
    pub page: u32,
    pub entries: Vec<QuaddictedEntry>,
    pub unreadable_rows: usize,
    /// The upstream response has no total. A full page only suggests more rows.
    pub may_have_more: bool,
}

pub(crate) struct QuaddictedReader {
    http: ProviderHttp,
}

impl QuaddictedReader {
    pub(crate) fn new(http: ProviderHttp) -> Self {
        Self { http }
    }

    pub(crate) async fn browse(
        &self,
        port: &PortDefinition,
        platform: Platform,
        filename_search: Option<&str>,
        page: u32,
    ) -> Result<Observed<QuaddictedPage>> {
        let engine = source(port, platform).ok_or_else(|| {
            PortcoveError::unsupported("this platform has no reviewed Quaddicted browser")
        })?;
        self.http
            .observe(endpoint(filename_search, page)?, |value| {
                project(value, engine, page)
            })
            .await
    }

    pub(crate) async fn review_page(
        &self,
        port: &PortDefinition,
        platform: Platform,
        url: &str,
    ) -> Result<String> {
        let engine = source(port, platform).ok_or_else(|| {
            PortcoveError::unsupported("this platform has no reviewed Quaddicted browser")
        })?;
        if url == DIRECTORY {
            return Ok(url.into());
        }
        let sha = url
            .strip_prefix(MAP_PAGE)
            .filter(|value| valid_sha256(value))
            .ok_or_else(|| {
                PortcoveError::verification("the page is outside the reviewed Quaddicted directory")
            })?;
        let result = self
            .http
            .observe(
                query_url(&format!("{FILTER} +sha256:{sha}"), 0, 2)?,
                |value| project(value, engine, 0),
            )
            .await?;
        if result.freshness == crate::ProviderFreshness::Stale
            || result.value.unreadable_rows != 0
            || result.value.entries.len() != 1
            || result.value.entries[0].page_url != url
        {
            return Err(PortcoveError::verification(
                "Quaddicted did not confirm this reviewed page",
            ));
        }
        Ok(url.into())
    }
}

fn endpoint(search: Option<&str>, page: u32) -> Result<Url> {
    if page > MAX_PAGE {
        return Err(PortcoveError::usage(
            "Quaddicted page exceeds the browsing limit",
        ));
    }
    let mut query = FILTER.to_owned();
    if let Some(term) = search.map(str::trim).filter(|term| !term.is_empty()) {
        if !(2..=64).contains(&term.len())
            || !term
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
        {
            return Err(PortcoveError::usage(
                "search Quaddicted by 2–64 filename characters (letters, digits, periods, underscores or hyphens)",
            ));
        }
        // Hyphen is valid in a filename, but a Solr operator outside escaping.
        let term = term.replace('-', "\\-");
        query.push_str(&format!(" +filenames_txt:*{term}*"));
    }
    query_url(&query, page as usize * PAGE_SIZE, PAGE_SIZE)
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn query_url(query: &str, start: usize, rows: usize) -> Result<Url> {
    let mut url = Url::parse(API).map_err(|error| PortcoveError::state(error.to_string()))?;
    url.query_pairs_mut()
        .append_pair("q", query)
        .append_pair("fl", "sha256,tags,urls,bytes,install,notes")
        .append_pair("rows", &rows.to_string())
        .append_pair("start", &start.to_string())
        .append_pair("sort", "release_date_dt DESC, sha256 ASC");
    Ok(url)
}

fn project(value: &Value, engine: QuakeEngine, page: u32) -> Result<QuaddictedPage> {
    let rows = value
        .as_array()
        .filter(|rows| rows.len() <= PAGE_SIZE)
        .ok_or_else(|| {
            PortcoveError::verification("Quaddicted returned an invalid or oversized page")
        })?;
    let mut seen = BTreeSet::new();
    let mut duplicated = BTreeSet::new();
    let mut entries = Vec::new();
    for entry in rows.iter().filter_map(|row| entry(row, engine)) {
        if seen.insert(entry.claimed_sha256.clone()) {
            entries.push(entry);
        } else {
            duplicated.insert(entry.claimed_sha256);
        }
    }
    entries.retain(|entry| !duplicated.contains(&entry.claimed_sha256));
    Ok(QuaddictedPage {
        attribution: "Quaddicted".into(),
        source_url: DIRECTORY.into(),
        engine,
        page,
        unreadable_rows: rows.len() - entries.len(),
        may_have_more: rows.len() == PAGE_SIZE,
        entries,
    })
}

fn entry(row: &Value, engine: QuakeEngine) -> Option<QuaddictedEntry> {
    let sha = row.get("sha256")?.as_str()?;
    if !valid_sha256(sha) {
        return None;
    }
    let tags = row
        .get("tags")?
        .as_array()
        .filter(|tags| tags.len() <= 128)?;
    if tags
        .iter()
        .any(|tag| tag.as_str().is_none_or(|tag| tag.len() > 1024))
    {
        return None;
    }
    let get = |key: &str| {
        tags.iter()
            .filter_map(Value::as_str)
            .filter_map(|tag| tag.split_once('='))
            .filter_map(|(name, value)| (name == key).then_some(value))
            .collect::<Vec<_>>()
    };
    if !get("game").contains(&"quake") || !get("game_mode").contains(&"singleplayer") {
        return None;
    }
    let text_values = |key| {
        get(key)
            .into_iter()
            .map(sanitize_text)
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
    };
    let filename = text_values("filename").into_iter().next();
    let title = text_values("title")
        .into_iter()
        .next()
        .or_else(|| filename.clone())?;
    let engine_requirements = get("requires_engine");
    // Only an explicit requirement for a known different engine is a conflict.
    // Map format, stock-engine limits and matching names never prove compatibility.
    let incompatible =
        matches!(engine_requirements.as_slice(), [name] if named_other_engine(engine, name));
    let mut requirements = [
        "requires_engine",
        "engine",
        "bsp_format",
        "exceeds_quake_limits",
    ]
    .into_iter()
    .flat_map(|key| {
        text_values(key)
            .into_iter()
            .map(move |value| format!("{key}={value}"))
    })
    .collect::<Vec<_>>();
    requirements.dedup();
    let source_urls = row
        .get("urls")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(8)
        .filter_map(Value::as_str)
        .filter(|url| display_source(url))
        .map(str::to_owned)
        .collect();
    let install = row.get("install").and_then(Value::as_object);
    let bounded_literal = |value: &Value| {
        value
            .as_str()
            .filter(|value| {
                !value.is_empty() && value.len() <= 256 && sanitize_text(value) == *value
            })
            .map(str::to_owned)
    };
    let extract = install
        .and_then(|install| install.get("extract"))
        .and_then(bounded_literal);
    let extract_mapping = install
        .and_then(|install| install.get("extractmapping"))
        .and_then(Value::as_object)
        .filter(|map| map.len() <= 32)
        .into_iter()
        .flatten()
        .filter_map(|(input, output)| {
            let output = bounded_literal(output)?;
            (input.len() <= 256 && !input.is_empty() && sanitize_text(input) == *input)
                .then(|| (input.clone(), output))
        })
        .collect();
    let mut dependencies = text_values("depends");
    dependencies.extend(text_values("dependency"));
    Some(QuaddictedEntry {
        title,
        page_url: format!("{MAP_PAGE}{sha}"),
        filename,
        authors: text_values("author"),
        release_date: text_values("release_date").into_iter().next(),
        claimed_sha256: sha.to_owned(),
        claimed_bytes: row
            .get("bytes")
            .and_then(Value::as_u64)
            .filter(|bytes| *bytes > 0),
        source_urls,
        content_kind: text_values("type"),
        engine_requirements: requirements,
        provider_notes: row
            .get("notes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .take(12)
            .filter_map(Value::as_str)
            .map(sanitize_text)
            .filter(|value| !value.is_empty())
            .collect(),
        engine_compatibility: if incompatible {
            QuaddictedEngineCompatibility::DeclaresAnotherRequiredEngine
        } else {
            QuaddictedEngineCompatibility::Unverified
        },
        install_notes: QuaddictedInstallNotes {
            extract,
            extract_mapping,
            command_line: text_values("commandline"),
            start_maps: text_values("startmap"),
            dependencies,
        },
    })
}

fn named_other_engine(engine: QuakeEngine, required: &str) -> bool {
    match required.to_ascii_lowercase().as_str() {
        "vkquake" => engine != QuakeEngine::VkQuake,
        "ironwail" => engine != QuakeEngine::Ironwail,
        "darkplaces" | "fteqw" | "quakespasm" => true,
        _ => false,
    }
}

fn display_source(value: &str) -> bool {
    value.len() <= 1024
        && Url::parse(value).is_ok_and(|url| {
            url.scheme() == "https"
                && url.port_or_known_default() == Some(443)
                && url.username().is_empty()
                && url.password().is_none()
                && matches!(
                    url.host_str(),
                    Some("www.quaddicted.com" | "www.quaketastic.com" | "x901.net")
                )
                && url.query().is_none()
                && url.fragment().is_none()
        })
}

#[cfg(test)]
#[path = "quaddicted_tests.rs"]
mod tests;
