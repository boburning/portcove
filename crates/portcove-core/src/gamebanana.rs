//! GameBanana adapter: search and project observations, never acquisition.
//!
//! Evidence (November 11, 2026, live API v11, unauthenticated reads): a game ID is
//! resolved with `Util/Game/NameMatch`; `Mod/Index` filtered by `Generic_Game`
//! pages mod summaries; `Mod/<id>` with `_csvProperties` returns the file list.
//! Each file has its own ID, name, size, add date, a canonical `/dl/<id>` location
//! and an MD5 claim. The displayed version and `_tsDateUpdated` are separate from
//! file identity, so file IDs and dates, not version labels, detect changed bytes.
use std::path::Path;

use serde_json::Value;

use crate::{
    Library, PortcoveError, Result,
    mod_provider::{
        Observed, ProviderFileCandidate, ProviderPage, ProviderProject, numeric_id, sanitize_text,
    },
    provider_http::ProviderHttp,
};

pub const PROVIDER: &str = "gamebanana";
const API_ROOT: &str = "https://gamebanana.com/apiv11";
const MAX_PER_PAGE: u32 = 50;
/// More files than this in one project is refused rather than silently truncated,
/// so a newer file can never be missed.
const MAX_PROJECT_FILES: usize = 256;
const FILE_PROPERTIES: &str =
    "_sName,_sVersion,_aFiles,_bIsObsolete,_tsDateUpdated,_sProfileUrl,_aSubmitter,_aGame";

#[derive(Clone)]
pub struct GameBananaClient {
    http: ProviderHttp,
    api_root: String,
    web_root: String,
}

impl GameBananaClient {
    pub fn for_library(library: &Library) -> Result<Self> {
        Self::build(Some(library.clone()), API_ROOT, "https://gamebanana.com")
    }

    fn build(library: Option<Library>, api_root: &str, web_root: &str) -> Result<Self> {
        Ok(Self {
            http: ProviderHttp::new(library, "GameBanana", "gamebanana.com")?,
            api_root: api_root.trim_end_matches('/').into(),
            web_root: web_root.trim_end_matches('/').into(),
        })
    }

    #[cfg(test)]
    pub(crate) fn with_roots(root: &str, library: Option<Library>) -> Result<Self> {
        Self::build(library, &format!("{root}/apiv11"), root)
    }

    /// One page of Mod summaries for a game. `per_page` is clamped to 50.
    pub async fn search(
        &self,
        game_id: u64,
        page: u32,
        per_page: u32,
    ) -> Result<Observed<ProviderPage>> {
        let per_page = per_page.clamp(1, MAX_PER_PAGE);
        let page = page.max(1);
        let mut url = self.url("Mod/Index")?;
        url.query_pairs_mut()
            .append_pair("_nPerpage", &per_page.to_string())
            .append_pair("_nPage", &page.to_string())
            .append_pair("_aFilters[Generic_Game]", &game_id.to_string())
            .append_pair("_sSort", "Generic_MostDownloaded");
        let web_root = self.web_root.clone();
        self.http
            .observe(url, move |value| parse_index(value, page, &web_root))
            .await
    }

    /// The exact file list and version for one Mod.
    pub async fn project(&self, project_id: u64) -> Result<Observed<ProviderProject>> {
        if project_id == 0 {
            return Err(PortcoveError::usage("GameBanana project IDs are positive"));
        }
        let mut url = self.url(&format!("Mod/{project_id}"))?;
        url.query_pairs_mut()
            .append_pair("_csvProperties", FILE_PROPERTIES);
        let web_root = self.web_root.clone();
        self.http
            .observe(url, move |value| {
                parse_project(value, project_id, &web_root)
            })
            .await
    }

    /// Streams one file to `destination` from its canonical location; see
    /// [`ProviderHttp::download`].
    pub(crate) async fn download_file(
        &self,
        file: &ProviderFileCandidate,
        destination: &Path,
        max_bytes: u64,
    ) -> Result<(String, u64)> {
        let canonical = canonical_download(&self.web_root, &file.file_id);
        self.http
            .download(file, &canonical, destination, max_bytes)
            .await
    }

    fn url(&self, path: &str) -> Result<reqwest::Url> {
        reqwest::Url::parse(&format!("{}/{path}", self.api_root))
            .map_err(|error| PortcoveError::state(error.to_string()))
    }
}

fn canonical_download(web_root: &str, file_id: &str) -> String {
    format!("{web_root}/dl/{file_id}")
}

fn parse_file(value: &Value, web_root: &str) -> Option<ProviderFileCandidate> {
    let file_id = numeric_id(&value["_idRow"])?;
    let file_name = sanitize_text(value["_sFile"].as_str()?);
    // The name becomes a staging and mods-folder file name: refuse drive, stream,
    // separator, hidden and other non-plain names before anything is downloaded.
    if !crate::profile::valid_native_id(&file_name) {
        return None;
    }
    let download_url = canonical_download(web_root, &file_id);
    // A provider-supplied location that disagrees with the canonical one means the
    // record is not trustworthy enough to become a candidate.
    if let Some(supplied) = value["_sDownloadUrl"].as_str()
        && supplied != download_url
    {
        return None;
    }
    let md5 = value["_sMd5Checksum"]
        .as_str()
        .filter(|md5| md5.len() == 32 && md5.bytes().all(|b| b.is_ascii_hexdigit()))
        .map(str::to_ascii_lowercase);
    Some(ProviderFileCandidate {
        file_id,
        file_name,
        size: value["_nFilesize"].as_u64()?,
        added_at: value["_tsDateAdded"].as_i64().unwrap_or_default(),
        download_url,
        claimed_md5: md5,
        archived: value["_bIsArchived"].as_bool().unwrap_or(false),
        claimed_scan: value["_sAvResult"].as_str().map(sanitize_text),
    })
}

fn parse_summary(value: &Value, web_root: &str) -> Option<ProviderProject> {
    let project_id = numeric_id(&value["_idRow"])?;
    // Records that cannot be read are counted, never silently treated as absent.
    let (files, unreadable_files) = match &value["_aFiles"] {
        Value::Array(files) => {
            let parsed = files
                .iter()
                .filter_map(|file| parse_file(file, web_root))
                .collect::<Vec<_>>();
            let unreadable = files.len() - parsed.len();
            (parsed, unreadable)
        }
        Value::Null => (Vec::new(), 0),
        _ => (Vec::new(), 1),
    };
    Some(ProviderProject {
        provider: PROVIDER.into(),
        profile_url: format!("{web_root}/mods/{project_id}"),
        project_id,
        name: sanitize_text(value["_sName"].as_str()?),
        version: value["_sVersion"]
            .as_str()
            .map(sanitize_text)
            .filter(|v| !v.is_empty()),
        game_id: numeric_id(&value["_aGame"]["_idRow"]),
        updated_at: value["_tsDateUpdated"]
            .as_i64()
            .or_else(|| value["_tsDateModified"].as_i64())
            .unwrap_or_default(),
        obsolete: value["_bIsObsolete"].as_bool().unwrap_or(false),
        submitter: value["_aSubmitter"]["_sName"].as_str().map(sanitize_text),
        files,
        unreadable_files: u32::try_from(unreadable_files).unwrap_or(u32::MAX),
    })
}

pub(crate) fn parse_index(value: &Value, page: u32, web_root: &str) -> Result<ProviderPage> {
    let records = value["_aRecords"]
        .as_array()
        .ok_or_else(|| PortcoveError::verification("GameBanana index has no record list"))?;
    if records.len() > MAX_PER_PAGE as usize {
        return Err(PortcoveError::verification(
            "GameBanana page exceeds its bound",
        ));
    }
    Ok(ProviderPage {
        projects: records
            .iter()
            .filter_map(|record| parse_summary(record, web_root))
            .collect(),
        total: value["_aMetadata"]["_nRecordCount"]
            .as_u64()
            .unwrap_or_default(),
        page,
        complete: value["_aMetadata"]["_bIsComplete"]
            .as_bool()
            .unwrap_or(false),
    })
}

pub(crate) fn parse_project(
    value: &Value,
    expected_id: u64,
    web_root: &str,
) -> Result<ProviderProject> {
    let mut object = value.clone();
    // The property-filtered response omits the identity; bind it from the request.
    object["_idRow"] = Value::from(expected_id);
    if object["_sName"].as_str().is_none() {
        return Err(PortcoveError::verification(
            "GameBanana project has no name",
        ));
    }
    if object["_aFiles"]
        .as_array()
        .is_some_and(|files| files.len() > MAX_PROJECT_FILES)
    {
        return Err(PortcoveError::verification(
            "the project lists more files than this client can review completely",
        ));
    }
    parse_summary(&object, web_root)
        .ok_or_else(|| PortcoveError::verification("GameBanana project record is invalid"))
}

#[cfg(test)]
#[path = "gamebanana_tests.rs"]
mod tests;
