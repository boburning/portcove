//! Non-owning upstream acquisition and the durable handoff into manual setup.
//! A receipt proves publication of this attempt; it never grants update/delete
//! ownership of the destination or attests the user's subsequent installation.
use super::user_selected::managed_overlap_key;
use super::*;
use crate::{GithubReleaseProvider, PortListing};
use rusqlite::{TransactionBehavior, params};

const RECORD_LIMIT: usize = 64 * 1024;
const RECORDS_LIMIT: usize = 10_000;
const TOTAL_RECORD_BYTES: usize = 8 * 1024 * 1024;
const RECEIPT_NAME: &str = ".portcove-download.json";

#[cfg(test)]
#[path = "catalog_download_tests.rs"]
mod tests;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CatalogDownloadRequest {
    pub port_id: String,
    pub release_id: u64,
    pub asset_id: u64,
    pub destination_parent: PathBuf,
    pub extract_archive: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct CatalogDownloadCandidate {
    pub release_id: u64,
    pub asset_id: u64,
    pub release_tag: String,
    pub release_url: String,
    pub name: String,
    pub size: u64,
    pub download_url: String,
    pub sha256: Option<String>,
    pub can_extract: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CatalogDownloadCoverage {
    pub release_limit: usize,
    pub candidate_limit: usize,
    /// Published releases whose dedicated asset inventory was fully inspected.
    pub releases_checked: usize,
    /// A short first page established the end of the visible release history.
    pub release_history_complete: bool,
    /// All assets from the returned published releases are represented.
    pub candidates_complete: bool,
}

impl CatalogDownloadCoverage {
    fn reason(&self, empty: bool) -> Option<String> {
        if empty && !self.release_history_complete {
            return Some(format!(
                "No release assets were found in the recent releases checked here (up to {}). Older downloads may be available upstream; open the releases page or attach an existing executable.",
                self.release_limit,
            ));
        }
        if empty {
            return Some("No published release assets are available; open upstream instructions or attach an existing executable.".into());
        }
        match (self.release_history_complete, self.candidates_complete) {
            (true, true) => None,
            (false, true) => Some(format!(
                "This search covers up to {} recent releases. Older downloads may be available upstream.",
                self.release_limit,
            )),
            (true, false) => Some(format!(
                "This search shows at most {} files. More downloads may be available upstream.",
                self.candidate_limit,
            )),
            (false, false) => Some(format!(
                "This search covers up to {} recent releases and shows at most {} files. More downloads may be available upstream.",
                self.release_limit, self.candidate_limit,
            )),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CatalogDownloadCandidates {
    pub port_id: String,
    pub allowed: bool,
    pub reason: Option<String>,
    pub candidates: Vec<CatalogDownloadCandidate>,
    /// Absent when an availability or provider refusal prevented discovery.
    pub coverage: Option<CatalogDownloadCoverage>,
    pub default_destination_parent: Option<PathBuf>,
    pub upstream_url: String,
    pub releases: Vec<crate::CatalogDownloadRelease>,
    pub selected_release_id: Option<u64>,
    pub recommended_asset_id: Option<u64>,
    pub packages: Vec<crate::CatalogPackageAssessment>,
    pub recommendation_reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CatalogDownloadPreview {
    pub request: CatalogDownloadRequest,
    pub artifact: CatalogDownloadCandidate,
    pub destination_path: PathBuf,
    pub preview_sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum PendingSetupState {
    Downloaded,
    AttentionRequired,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PendingSetupRecord {
    pub id: String,
    pub port_id: String,
    pub listing: PortListing,
    pub path: PathBuf,
    pub state: PendingSetupState,
    pub artifact: CatalogDownloadCandidate,
    /// Observed archive bytes, not a curated acceptance or executable identity.
    pub archive_sha256: String,
    pub downloaded_at: String,
    pub reason: Option<String>,
}

#[derive(Debug)]
struct StoredDownload {
    record: PendingSetupRecord,
    record_json: String,
    stage_path: Option<PathBuf>,
    phase: String,
    preview_sha256: String,
    activity_id: String,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PublicationReceipt {
    format_version: u32,
    pending_id: String,
    port_id: String,
    preview_sha256: String,
    archive_sha256: String,
}

fn is_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn validate_record(record: &PendingSetupRecord) -> Result<()> {
    record.listing.validate()?;
    if record.port_id != record.listing.id
        || Uuid::parse_str(&record.id).is_err()
        || !record.path.is_absolute()
        || record.artifact.release_id == 0
        || record.artifact.asset_id == 0
        || record.artifact.name.len() > 255
        || record.artifact.name.contains(['/', '\\'])
        || record.artifact.release_tag.len() > 512
        || record.artifact.download_url.len() > 4096
        || record.artifact.release_url.len() > 4096
        || record.downloaded_at.len() > 128
        || record
            .reason
            .as_ref()
            .is_some_and(|reason| reason.len() > 8192)
        || (!record.archive_sha256.is_empty() && !is_digest(&record.archive_sha256))
        || (record.state == PendingSetupState::Downloaded && !is_digest(&record.archive_sha256))
        || record
            .artifact
            .sha256
            .as_ref()
            .is_some_and(|digest| !is_digest(digest))
    {
        return Err(PortcoveError::verification(
            "pending setup identity is invalid",
        ));
    }
    crate::path::unicode(&record.path, "pending setup")?;
    crate::archive::validate_relative_path(&record.artifact.name, false)?;
    crate::archive::validate_download_progress(0, record.artifact.size)?;
    Ok(())
}

fn encoded_download_record(record: &PendingSetupRecord) -> Result<String> {
    validate_record(record)?;
    let json = serde_json::to_string(record)?;
    if json.len() > RECORD_LIMIT {
        return Err(PortcoveError::conflict(
            "pending setup record exceeds its UTF-8 byte limit",
        ));
    }
    Ok(json)
}

// Called under the same immediate writer transaction as the following insert
// or replacement, so concurrent downloads cannot each spend the same capacity.
fn require_download_record_capacity(
    connection: &rusqlite::Connection,
    port_id: &str,
    json: &str,
) -> Result<()> {
    let (other_count, other_bytes): (usize, usize) = connection.query_row(
        "SELECT count(*),coalesce(sum(length(CAST(record_json AS BLOB))),0)
         FROM (SELECT record_json FROM catalog_downloads WHERE port_id<>?1 LIMIT 10001)",
        [port_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if json.len() > RECORD_LIMIT
        || other_count >= RECORDS_LIMIT
        || other_bytes.saturating_add(json.len()) > TOTAL_RECORD_BYTES
    {
        return Err(PortcoveError::conflict(
            "pending setup records exceed their storage capacity; forget a completed setup before adding another",
        ));
    }
    Ok(())
}

fn stored_downloads_from(connection: &rusqlite::Connection) -> Result<Vec<StoredDownload>> {
    let mut statement = connection.prepare(
        "SELECT port_id,pending_id,record_json,stage_path,phase,preview_sha256,activity_id
         FROM catalog_downloads ORDER BY port_id LIMIT 10001",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, String>(5)?,
            row.get::<_, String>(6)?,
        ))
    })?;
    let mut total = 0_usize;
    let mut result = Vec::new();
    for row in rows {
        let (port_id, id, record_json, stage, phase, preview_sha256, activity_id) = row?;
        total = total.saturating_add(record_json.len());
        if record_json.len() > RECORD_LIMIT
            || total > TOTAL_RECORD_BYTES
            || result.len() >= RECORDS_LIMIT
        {
            return Err(PortcoveError::verification(
                "pending setup records exceed their read bound",
            ));
        }
        let _: crate::definition_entry::strict_json::UniqueValue =
            serde_json::from_str(&record_json)?;
        let record: PendingSetupRecord = serde_json::from_str(&record_json)?;
        validate_record(&record)?;
        if record.port_id != port_id
            || record.id != id
            || !is_digest(&preview_sha256)
            || Uuid::parse_str(&activity_id).is_err()
            || !matches!(
                phase.as_str(),
                "preparing" | "publication-intent" | "downloaded" | "attention-required"
            )
        {
            return Err(PortcoveError::verification(
                "pending setup row differs from its retained identity",
            ));
        }
        result.push(StoredDownload {
            record,
            record_json,
            stage_path: stage.map(PathBuf::from),
            phase,
            preview_sha256,
            activity_id,
        });
    }
    Ok(result)
}

impl PortcoveService {
    pub fn pending_setups(&self) -> Result<Vec<PendingSetupRecord>> {
        Self::pending_setups_from(&self.library.connection()?)
    }

    pub(crate) fn pending_setups_from(
        connection: &rusqlite::Connection,
    ) -> Result<Vec<PendingSetupRecord>> {
        Ok(stored_downloads_from(connection)?
            .into_iter()
            .map(|stored| stored.record)
            .collect())
    }

    pub(super) fn pending_setup_registration(
        &self,
        port_id: &str,
    ) -> Result<Option<(PendingSetupRecord, String)>> {
        Ok(stored_downloads_from(&self.library.connection()?)?
            .into_iter()
            .find(|stored| stored.record.port_id == port_id)
            .map(|stored| (stored.record, stored.record_json)))
    }

    pub(crate) fn require_no_pending_setup(&self, port_id: &str) -> Result<()> {
        let exists: bool = self.library.connection()?.query_row(
            "SELECT EXISTS(SELECT 1 FROM catalog_downloads WHERE port_id=?1)",
            [port_id],
            |row| row.get(0),
        )?;
        if exists {
            return Err(PortcoveError::conflict(
                "finish or forget this port's pending setup before choosing another installation route",
            ));
        }
        Ok(())
    }

    fn require_download_available(&self, port_id: &str) -> Result<()> {
        self.require_no_pending_setup(port_id)?;
        let state = self.library.status(port_id, ReleaseChannel::Stable)?;
        if state.external_runtime.is_some()
            || self
                .library
                .all_installs()?
                .iter()
                .any(|install| install.port_id == port_id)
            || self
                .library
                .launch_sessions()?
                .iter()
                .any(|session| session.port_id == port_id && session.outcome.is_none())
        {
            return Err(PortcoveError::conflict(
                "this port already has an installation or active launch; keep it or explicitly remove its registration/managed installation before downloading another route",
            ));
        }
        Ok(())
    }

    fn require_download_destination(&self, path: &Path) -> Result<()> {
        if !path.is_absolute() {
            return Err(PortcoveError::usage(
                "download destination must be absolute",
            ));
        }
        crate::path::unicode(path, "download destination")?;
        refuse_symlink_ancestors(path)?;
        let path_key = managed_overlap_key(path)?;
        let library = managed_overlap_key(&fs::canonicalize(self.library.root())?)?;
        if path_key.starts_with(&library) || library.starts_with(&path_key) {
            return Err(PortcoveError::conflict(
                "self-service downloads must be outside the entire Portcove Library folder",
            ));
        }
        self.require_user_selected_path_ownership(path, path)
    }

    fn download_destination(&self, request: &CatalogDownloadRequest) -> Result<PathBuf> {
        if !request.destination_parent.is_absolute() {
            return Err(PortcoveError::usage(
                "choose an absolute existing destination folder",
            ));
        }
        refuse_symlink_ancestors(&request.destination_parent)?;
        let parent = fs::canonicalize(&request.destination_parent)?;
        if !parent.is_dir() {
            return Err(PortcoveError::usage(
                "download parent must be an existing folder",
            ));
        }
        let destination = parent.join(format!(
            "{}-{}-{}",
            request.port_id, request.release_id, request.asset_id
        ));
        self.require_download_destination(&destination)?;
        match fs::symlink_metadata(&destination) {
            Ok(_) => Err(PortcoveError::conflict(
                "download destination already exists; choose another parent folder, or use the existing files",
            )),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(destination),
            Err(error) => Err(error.into()),
        }
    }

    pub async fn catalog_download_candidates(
        &self,
        port_id: &str,
    ) -> Result<CatalogDownloadCandidates> {
        self.catalog_download_options(port_id, None, ReleaseChannel::Stable)
            .await
    }

    pub async fn catalog_download_options(
        &self,
        port_id: &str,
        selected_release_id: Option<u64>,
        channel: ReleaseChannel,
    ) -> Result<CatalogDownloadCandidates> {
        let listing = self.catalog.listing(port_id)?;
        let upstream_url = listing
            .release_url
            .as_ref()
            .unwrap_or(&listing.project_url)
            .clone();
        let mut result = CatalogDownloadCandidates {
            port_id: port_id.into(),
            allowed: false,
            reason: None,
            candidates: Vec::new(),
            coverage: None,
            default_destination_parent: None,
            upstream_url: upstream_url.clone(),
            releases: Vec::new(),
            selected_release_id: None,
            recommended_asset_id: None,
            packages: Vec::new(),
            recommendation_reason: String::new(),
        };
        if let Err(error) = self.require_download_available(port_id) {
            result.reason = Some(error.message);
            return Ok(result);
        }
        let repository = match crate::release::catalog_download_repository(&upstream_url) {
            Ok(repository) => repository,
            Err(error) => {
                result.reason = Some(error.message);
                return Ok(result);
            }
        };
        let provider = GithubReleaseProvider::for_library(&self.library)?;
        let definition = self
            .catalog
            .port(port_id)
            .ok()
            .filter(|port| port.release.repository.eq_ignore_ascii_case(&repository));
        let rolling_tag = definition.and_then(|port| port.release.rolling_tag.as_deref());
        let (candidates, coverage, releases, selected) = provider
            .catalog_download_options(&repository, selected_release_id, channel, rolling_tag)
            .await?;
        result.releases = releases;
        result.selected_release_id = selected;
        let platform = Platform::current()?;
        let hints = definition
            .and_then(|port| port.release.asset_hints.get(&platform))
            .map(Vec::as_slice)
            .unwrap_or_default();
        let (packages, recommended) = super::package_selection::recommend_packages(
            &candidates,
            platform,
            hints,
            coverage.candidates_complete,
        );
        result.packages = packages;
        result.recommended_asset_id = recommended;
        result.recommendation_reason = if selected.is_none() {
            "No release for this channel was found in the recent history. Choose a release or open upstream releases.".into()
        } else if recommended.is_some() {
            "Recommended for this host. Suitability is not authenticity or gameplay verification."
                .into()
        } else if result
            .packages
            .iter()
            .any(|package| package.suitability == "suitable")
        {
            "Several plausible packages remain. Choose the build you want from this release.".into()
        } else {
            "No native package could be recommended. Check other downloads or follow upstream setup instructions.".into()
        };
        result.candidates = candidates;
        result.allowed = true;
        result.reason = coverage.reason(result.candidates.is_empty());
        result.coverage = Some(coverage);
        result.default_destination_parent = directories::UserDirs::new().and_then(|directories| {
            let mut choices = vec![directories.home_dir().join("Games")];
            choices.extend(directories.document_dir().map(|path| path.join("Games")));
            choices.extend(directories.download_dir().map(Path::to_path_buf));
            choices.push(directories.home_dir().to_path_buf());
            choices.into_iter().find(|parent| {
                parent.is_dir()
                    && self
                        .require_download_destination(&parent.join("portcove-self-service"))
                        .is_ok()
            })
        });
        Ok(result)
    }

    pub async fn preview_catalog_download(
        &self,
        request: &CatalogDownloadRequest,
    ) -> Result<CatalogDownloadPreview> {
        let provider = GithubReleaseProvider::for_library(&self.library)?;
        self.catalog_download_preview_with_provider(request, &provider)
            .await
    }

    async fn catalog_download_preview_with_provider(
        &self,
        request: &CatalogDownloadRequest,
        provider: &GithubReleaseProvider,
    ) -> Result<CatalogDownloadPreview> {
        let listing = self.catalog.listing(&request.port_id)?;
        listing.validate()?;
        self.require_download_available(&request.port_id)?;
        let destination_path = self.download_destination(request)?;
        let repository = crate::release::catalog_download_repository(
            listing
                .release_url
                .as_deref()
                .unwrap_or(&listing.project_url),
        )?;
        let artifact = provider
            .catalog_release_candidate(&repository, request.release_id, request.asset_id)
            .await?;
        if request.extract_archive && !artifact.can_extract {
            return Err(PortcoveError::unsupported(
                "this package cannot be safely extracted by Portcove; download it for upstream/native setup",
            ));
        }
        let expected = self.known_catalog_artifact_hash(&request.port_id, &artifact)?;
        if let (Some(expected), Some(published)) = (&expected, &artifact.sha256)
            && !expected.eq_ignore_ascii_case(published)
        {
            return Err(PortcoveError::verification(
                "upstream digest conflicts with this exact artifact's known checksum; self-service cannot bypass that failure",
            ));
        }
        let preview_sha256 = crate::signed_catalog::digest(&serde_json::to_vec(&(
            1_u32,
            request,
            &artifact,
            &destination_path,
            listing,
            expected,
        ))?);
        Ok(CatalogDownloadPreview {
            request: request.clone(),
            artifact,
            destination_path,
            preview_sha256,
        })
    }

    fn known_catalog_artifact_hash(
        &self,
        port_id: &str,
        candidate: &CatalogDownloadCandidate,
    ) -> Result<Option<String>> {
        self.known_catalog_artifact_hash_from(&self.library.connection()?, port_id, candidate)
    }

    fn known_catalog_artifact_hash_from(
        &self,
        connection: &rusqlite::Connection,
        port_id: &str,
        candidate: &CatalogDownloadCandidate,
    ) -> Result<Option<String>> {
        let mut hashes = Vec::new();
        if let Some((repository_id, sha256)) = crate::curated_acquisition::known_download_identity(
            connection,
            candidate.asset_id,
            candidate.release_id,
            &candidate.download_url,
            candidate.size,
        )? {
            let assessment = crate::definition_repository::publisher_policy::assess_known_artifact_operation(
                connection, repository_id, candidate.asset_id, &sha256,
                crate::definition_repository::publisher_policy::CuratedArtifactOperation::Acquisition)?;
            if assessment.outcome != crate::DefinitionEligibilityOutcome::Eligible {
                return Err(PortcoveError::conflict("this exact artifact has a retained acquisition hold; self-service cannot bypass its revocation or withdrawn distribution")
                    .detail("reason", enum_value(assessment.reason)?));
            }
            hashes.push(sha256);
        }
        if let Ok(port) = self.catalog.port(port_id) {
            hashes.extend(
                port.release
                    .curated
                    .values()
                    .filter(|entry| {
                        entry.release_id == candidate.release_id
                            && entry.asset_id == candidate.asset_id
                            && entry.acquisition_url == candidate.download_url
                    })
                    .map(|entry| entry.sha256.clone()),
            );
            hashes.extend(
                port.release
                    .direct
                    .values()
                    .filter(|entry| entry.url == candidate.download_url)
                    .map(|entry| entry.sha256.clone()),
            );
        }
        hashes.sort();
        hashes.dedup();
        if hashes.len() > 1 {
            return Err(PortcoveError::verification(
                "known checksums for this artifact conflict",
            ));
        }
        Ok(hashes.pop())
    }

    pub async fn download_catalog_package<F>(
        &self,
        request: &CatalogDownloadRequest,
        expected_preview_sha256: &str,
        on_event: F,
    ) -> Result<PendingSetupRecord>
    where
        F: FnMut(OperationEvent),
    {
        let provider = GithubReleaseProvider::for_library(&self.library)?;
        self.download_catalog_package_with_provider(
            request,
            expected_preview_sha256,
            on_event,
            &provider,
        )
        .await
    }

    async fn download_catalog_package_with_provider<F>(
        &self,
        request: &CatalogDownloadRequest,
        expected_preview_sha256: &str,
        mut on_event: F,
        provider: &GithubReleaseProvider,
    ) -> Result<PendingSetupRecord>
    where
        F: FnMut(OperationEvent),
    {
        let (activity, operation) = self.begin_cancellable_activity(
            ActivityOperation::DownloadPackage,
            ActivityTargetKind::Port,
            Some(&request.port_id),
        )?;
        on_event(operation.started());
        let result = async {
            let _lock = self
                .library
                .try_lock_port(&request.port_id, "download-package")?;
            let preview = operation
                .interruptible(self.catalog_download_preview_with_provider(request, provider))
                .await?;
            if preview.preview_sha256 != expected_preview_sha256 {
                return Err(PortcoveError::conflict(
                    "selected package or destination changed after review",
                ));
            }
            let parent = preview
                .destination_path
                .parent()
                .ok_or_else(|| PortcoveError::state("download destination has no parent"))?;
            let stage = tempfile::Builder::new()
                .prefix(".portcove-download-")
                .tempdir_in(parent)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(stage.path(), fs::Permissions::from_mode(0o700))?;
            }
            self.require_download_destination(stage.path())?;
            let mut record = PendingSetupRecord {
                id: Uuid::new_v4().to_string(),
                port_id: request.port_id.clone(),
                listing: self.catalog.listing(&request.port_id)?.clone(),
                path: preview.destination_path.clone(),
                state: PendingSetupState::AttentionRequired,
                artifact: preview.artifact.clone(),
                archive_sha256: String::new(),
                downloaded_at: String::new(),
                reason: Some("Package download is in progress.".into()),
            };
            self.insert_catalog_download(
                &record,
                stage.path(),
                &preview.preview_sha256,
                &activity.id,
            )?;
            let transfer_result = async {
                let artifact = crate::ReleaseAsset {
                    name: record.artifact.name.clone(),
                    url: record.artifact.download_url.clone(),
                    size: record.artifact.size,
                    sha256: record.artifact.sha256.clone().unwrap_or_default(),
                };
                let source = stage.path().join("artifact.download");
                Installer::download_with_client(
                    &provider.catalog_download_client()?,
                    &artifact,
                    &source,
                    &operation,
                    &mut on_event,
                )
                .await?;
                let (archive_sha256, _) = crate::adapter::hash_file_bounded_with_checkpoint(
                    &source,
                    artifact.size,
                    || operation.checkpoint(),
                )?;
                let expected =
                    self.known_catalog_artifact_hash(&request.port_id, &record.artifact)?;
                for digest in record.artifact.sha256.iter().chain(expected.iter()) {
                    if !digest.eq_ignore_ascii_case(&archive_sha256) {
                        return Err(PortcoveError::verification(
                            "downloaded package failed SHA-256 verification",
                        )
                        .detail("expected", digest)
                        .detail("actual", &archive_sha256));
                    }
                }
                record.archive_sha256 = archive_sha256;
                record.downloaded_at = time::OffsetDateTime::now_utc()
                    .format(&time::format_description::well_known::Rfc3339)
                    .map_err(|error| PortcoveError::state(error.to_string()))?;
                let payload = stage.path().join("payload");
                fs::create_dir(&payload)?;
                if request.extract_archive {
                    // The worker holds the private directory and cancellation
                    // scope if the caller is dropped; no cleanup races extraction.
                    let worker_operation = operation.clone();
                    let name = artifact.name.clone();
                    let expected_size = artifact.size;
                    let worker_payload = payload.clone();
                    let (returned_stage, extracted) = tokio::task::spawn_blocking(move || {
                        let result = crate::archive::extract_archive_with_checkpoint(
                            &source,
                            &worker_payload,
                            &name,
                            expected_size,
                            &|| worker_operation.checkpoint(),
                        );
                        (stage, result)
                    })
                    .await
                    .map_err(|error| PortcoveError::install(error.to_string()))?;
                    extracted?;
                    // Keep the owner until the final handoff; only its private
                    // parent is cleaned after payload is moved out.
                    self.publish_catalog_download(
                        record,
                        returned_stage,
                        &payload,
                        &preview.preview_sha256,
                        &operation,
                    )
                } else {
                    let target = payload.join(&artifact.name);
                    fs::rename(&source, &target)?;
                    let lower = artifact.name.to_ascii_lowercase();
                    crate::permissions::normalize_archive_entry(
                        &target,
                        false,
                        lower.ends_with(".appimage") || lower.ends_with(".exe"),
                    )?;
                    self.publish_catalog_download(
                        record,
                        stage,
                        &payload,
                        &preview.preview_sha256,
                        &operation,
                    )
                }
            }
            .await;
            if let Err(error) = &transfer_result {
                self.mark_catalog_download_attention(
                    &request.port_id,
                    &activity.id,
                    &error.message,
                )?;
            }
            transfer_result
        }
        .await;
        let result = self.finish_activity(activity, result);
        on_event(operation.finished(OperationResult::from_result(&result)));
        result
    }

    fn insert_catalog_download(
        &self,
        record: &PendingSetupRecord,
        stage: &Path,
        preview: &str,
        activity_id: &str,
    ) -> Result<()> {
        let json = encoded_download_record(record)?;
        let mut connection = self.library.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let occupied: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM installs WHERE port_id=?1)
            OR EXISTS(SELECT 1 FROM external_runtime_registrations WHERE port_id=?1)
            OR EXISTS(SELECT 1 FROM catalog_downloads WHERE port_id=?1)",
            [&record.port_id],
            |row| row.get(0),
        )?;
        if occupied {
            return Err(PortcoveError::conflict(
                "this port acquired another installation or pending setup",
            ));
        }
        require_download_record_capacity(&transaction, &record.port_id, &json)?;
        transaction.execute("INSERT INTO catalog_downloads(port_id,pending_id,record_json,stage_path,phase,preview_sha256,activity_id)
            VALUES(?1,?2,?3,?4,'preparing',?5,?6)", params![record.port_id,record.id,json,crate::path::unicode(stage,"download staging")?,preview,activity_id])?;
        transaction.commit()?;
        Ok(())
    }

    fn update_catalog_download(
        &self,
        record: &PendingSetupRecord,
        phase: &str,
        clear_stage: bool,
    ) -> Result<()> {
        let json = encoded_download_record(record)?;
        let mut connection = self.library.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        require_download_record_capacity(&transaction, &record.port_id, &json)?;
        let changed = transaction.execute("UPDATE catalog_downloads SET record_json=?3,phase=?4,
            stage_path=CASE WHEN ?5 THEN NULL ELSE stage_path END WHERE port_id=?1 AND pending_id=?2",
            params![record.port_id,record.id,json,phase,clear_stage])?;
        if changed != 1 {
            return Err(PortcoveError::conflict(
                "pending setup changed during publication",
            ));
        }
        transaction.commit()?;
        Ok(())
    }

    fn update_catalog_download_diagnostic(
        &self,
        record: &PendingSetupRecord,
        phase: &str,
    ) -> Result<()> {
        match self.update_catalog_download(record, phase, false) {
            Err(error) if error.code == crate::ErrorCode::Conflict && record.reason.is_some() => {
                // Diagnostics may grow after an interruption. The already stored
                // identity must remain recoverable even when its bounded journal
                // has no room for the extra explanation.
                let mut compact = record.clone();
                compact.reason = None;
                self.update_catalog_download(&compact, phase, false)
            }
            result => result,
        }
    }

    fn publish_catalog_download(
        &self,
        mut record: PendingSetupRecord,
        stage: tempfile::TempDir,
        payload: &Path,
        preview_sha256: &str,
        operation: &OperationCoordinator,
    ) -> Result<PendingSetupRecord> {
        operation.checkpoint()?;
        self.require_download_destination(&record.path)?;
        self.require_download_destination(stage.path())?;
        let receipt = PublicationReceipt {
            format_version: 1,
            pending_id: record.id.clone(),
            port_id: record.port_id.clone(),
            preview_sha256: preview_sha256.into(),
            archive_sha256: record.archive_sha256.clone(),
        };
        crate::durability::write_json_atomically(&payload.join(RECEIPT_NAME), &receipt, false)?;
        // The extracted tree is already bounded and contains no links. Flush
        // its ordinary files before committing the publication receipt/intent.
        for path in crate::adapter::walk_files(payload)? {
            operation.checkpoint()?;
            // Windows FlushFileBuffers requires a writable handle. This is
            // still the private payload, opened without truncation or creation.
            fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(path)?
                .sync_all()?;
        }
        // This committed intent precedes the external folder becoming visible.
        // If the process stops after rename, the receipt identifies that attempt.
        record.reason = Some("Package is ready for folder handoff.".into());
        self.update_catalog_download(&record, "publication-intent", false)?;
        operation.begin_publication()?;
        // Policy admission uses an immediate transaction too. Serialize the
        // final exact-artifact check and handoff with any new revocation; long
        // transfer/extraction/fsync work happened before this short boundary.
        let mut connection = self.library.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let expected =
            self.known_catalog_artifact_hash_from(&transaction, &record.port_id, &record.artifact)?;
        if expected
            .as_ref()
            .is_some_and(|digest| !digest.eq_ignore_ascii_case(&record.archive_sha256))
        {
            return Err(PortcoveError::verification(
                "artifact integrity authority changed before folder handoff",
            ));
        }
        let still_pending: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM catalog_downloads
            WHERE port_id=?1 AND pending_id=?2 AND phase='publication-intent')",
            params![record.port_id, record.id],
            |row| row.get(0),
        )?;
        if !still_pending {
            return Err(PortcoveError::conflict(
                "pending setup changed before folder handoff",
            ));
        }
        record.state = PendingSetupState::Downloaded;
        record.reason = None;
        let json = encoded_download_record(&record)?;
        require_download_record_capacity(&transaction, &record.port_id, &json)?;
        crate::durability::rename_noreplace(payload, &record.path)?;
        crate::durability::sync_publication(
            record
                .path
                .parent()
                .ok_or_else(|| PortcoveError::state("download folder has no parent"))?,
        )?;
        let changed = transaction.execute(
            "UPDATE catalog_downloads SET record_json=?3,phase='downloaded',stage_path=NULL
            WHERE port_id=?1 AND pending_id=?2 AND phase='publication-intent'",
            params![record.port_id, record.id, json],
        )?;
        if changed != 1 {
            return Err(PortcoveError::conflict(
                "pending setup changed during folder handoff",
            ));
        }
        transaction.commit()?;
        drop(stage);
        Ok(record)
    }

    fn mark_catalog_download_attention(
        &self,
        port_id: &str,
        activity_id: &str,
        reason: &str,
    ) -> Result<()> {
        if let Some(mut stored) = stored_downloads_from(&self.library.connection()?)?
            .into_iter()
            .find(|stored| stored.record.port_id == port_id && stored.activity_id == activity_id)
        {
            // Preserve a publication intent after a failed final DB write/sync.
            // Recovery can then prove the handoff through its exact receipt.
            stored.record.state = PendingSetupState::AttentionRequired;
            stored.record.reason = Some(reason.chars().take(2048).collect());
            let phase = if stored.phase == "publication-intent" {
                "publication-intent"
            } else {
                "attention-required"
            };
            self.update_catalog_download_diagnostic(&stored.record, phase)?;
        }
        Ok(())
    }

    fn publication_receipt_matches(&self, stored: &StoredDownload) -> Result<bool> {
        self.require_download_destination(&stored.record.path)?;
        let path = stored.record.path.join(RECEIPT_NAME);
        refuse_symlink_ancestors(&path)?;
        let bytes = match crate::path::read_bounded_regular(&path, 4096) {
            Ok(bytes) => bytes,
            Err(_) => return Ok(false),
        };
        let receipt: PublicationReceipt = match serde_json::from_slice(&bytes) {
            Ok(receipt) => receipt,
            Err(_) => return Ok(false),
        };
        Ok(receipt
            == PublicationReceipt {
                format_version: 1,
                pending_id: stored.record.id.clone(),
                port_id: stored.record.port_id.clone(),
                preview_sha256: stored.preview_sha256.clone(),
                archive_sha256: stored.record.archive_sha256.clone(),
            })
    }

    pub(super) fn recover_catalog_downloads(&self) -> Result<()> {
        for mut stored in stored_downloads_from(&self.library.connection()?)? {
            if !matches!(stored.phase.as_str(), "preparing" | "publication-intent") {
                continue;
            }
            let _activity = match self.library.try_lock_activity(&stored.activity_id) {
                Ok(lock) => lock,
                Err(error) if error.code == crate::ErrorCode::Conflict => continue,
                Err(error) => return Err(error),
            };
            let _port = match self
                .library
                .try_lock_port(&stored.record.port_id, "recover-catalog-download")
            {
                Ok(lock) => lock,
                Err(error) if error.code == crate::ErrorCode::Conflict => continue,
                Err(error) => return Err(error),
            };
            // The inventory was read before the locks. Another process may have
            // completed or forgotten this attempt in between; never overwrite
            // that newer result using the earlier recovery observation.
            let Some(current) = stored_downloads_from(&self.library.connection()?)?
                .into_iter()
                .find(|current| {
                    current.record.port_id == stored.record.port_id
                        && current.record.id == stored.record.id
                })
            else {
                continue;
            };
            stored = current;
            if !matches!(stored.phase.as_str(), "preparing" | "publication-intent") {
                continue;
            }
            if stored.phase == "publication-intent"
                && self.publication_receipt_matches(&stored).unwrap_or(false)
            {
                stored.record.state = PendingSetupState::Downloaded;
                stored.record.reason = None;
                self.update_catalog_download(&stored.record, "downloaded", true)?;
            } else {
                stored.record.state = PendingSetupState::AttentionRequired;
                stored.record.reason = Some(match &stored.stage_path {
                    Some(path) => format!("Download was interrupted before a proven folder handoff. Any private preparation at {} has been preserved; inspect it or forget this setup before retrying.", path.display()),
                    None => "Download was interrupted before a proven folder handoff; inspect its destination before retrying.".into(),
                });
                self.update_catalog_download_diagnostic(&stored.record, "attention-required")?;
            }
        }
        Ok(())
    }

    pub fn forget_pending_setup(&self, port_id: &str, pending_id: &str) -> Result<()> {
        let _lock = self
            .library
            .try_lock_port(port_id, "forget-pending-setup")?;
        let stored = stored_downloads_from(&self.library.connection()?)?
            .into_iter()
            .find(|stored| stored.record.port_id == port_id && stored.record.id == pending_id)
            .ok_or_else(|| PortcoveError::conflict("pending setup changed or no longer exists"))?;
        let _activity = self.library.try_lock_activity(&stored.activity_id)?;
        let changed = self.library.connection()?.execute(
            "DELETE FROM catalog_downloads WHERE port_id=?1 AND pending_id=?2 AND record_json=?3",
            params![port_id, pending_id, stored.record_json],
        )?;
        if changed != 1 {
            return Err(PortcoveError::conflict(
                "pending setup changed after review",
            ));
        }
        // The destination and any retained private staging are deliberately not
        // traversed or deleted by this bookkeeping operation.
        Ok(())
    }

    pub fn pending_setup_folder(&self, port_id: &str, pending_id: &str) -> Result<PathBuf> {
        let stored = stored_downloads_from(&self.library.connection()?)?
            .into_iter()
            .find(|stored| stored.record.port_id == port_id && stored.record.id == pending_id)
            .ok_or_else(|| PortcoveError::conflict("pending setup changed or no longer exists"))?;
        self.require_download_destination(&stored.record.path)?;
        if stored.record.state != PendingSetupState::Downloaded
            && !self.publication_receipt_matches(&stored)?
        {
            return Err(PortcoveError::state(
                "this attempt has no proven published setup folder",
            ));
        }
        if !stored.record.path.is_dir()
            || fs::canonicalize(&stored.record.path)? != stored.record.path
        {
            return Err(PortcoveError::conflict(
                "downloaded setup folder is missing or redirected",
            ));
        }
        Ok(stored.record.path)
    }
}
