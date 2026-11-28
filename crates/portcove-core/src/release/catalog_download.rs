//! Explicit selection from bounded GitHub release metadata. This does not resolve
//! managed runtime definitions or turn descriptive platform labels into grants.
use super::*;
use crate::acquisition_restriction::{
    EffectiveRestrictions, RestrictedOperation, RestrictionState, RestrictionSubject,
    SubjectArtifact,
};
use crate::service::package_selection::{PackageSuitability, assess_package_name};
use crate::{CatalogDownloadCandidate, CatalogDownloadCoverage};
use std::borrow::Cow;

/// Releases the chooser lists by default; a caller can ask for a larger
/// window, in steps, up to `MAX_RELEASE_WINDOW`.
const RELEASE_LIMIT: usize = 10;

/// Restriction evidence can improve the suggested release. This selection still
/// goes through the normal per-file offer and byte checks.
#[derive(Clone, Copy, Default)]
pub(crate) struct GithubCatalogDownloadScope<'a> {
    pub(crate) other_stream_prefixes: &'a [String],
    pub(crate) reviewed: Option<(&'a EffectiveRestrictions, Platform)>,
    pub(crate) package_hints: &'a [String],
}

impl GithubCatalogDownloadScope<'_> {
    pub(super) fn select<'a>(
        &self,
        releases: &'a [GithubRelease],
        channel: ReleaseChannel,
        rolling_tag: Option<&str>,
        complete_assets: impl Fn(&GithubRelease) -> bool,
    ) -> Option<&'a GithubRelease> {
        let selectable = |release: &GithubRelease| {
            !release.draft && tag_in_stream(&release.tag_name, self.other_stream_prefixes)
        };
        let ordinary = select_channel_candidate(
            releases,
            channel,
            rolling_tag,
            selectable,
            is_beta_release,
            |release| &release.tag_name,
        );
        if let Some((restrictions, platform)) = self.reviewed {
            let requires_preview =
                channel == ReleaseChannel::Beta && ordinary.is_some_and(is_beta_release);
            let explicitly_permitted = |release: &GithubRelease| {
                selectable(release)
                    && (!requires_preview || is_beta_release(release))
                    && complete_assets(release)
                    && release.assets.iter().any(|asset| {
                        let Some(sha256) = asset.digest.as_deref().and_then(parse_digest) else {
                            return false;
                        };
                        let subject = RestrictionSubject::deferred(RestrictedOperation::Download)
                            .on(platform)
                            .artifact(SubjectArtifact {
                                version: &release.tag_name,
                                sha256: &sha256,
                                asset_name: Some(&asset.name),
                            })
                            .final_check();
                        restrictions.evaluate(&subject).state == RestrictionState::Permitted
                            && assess_package_name(
                                &asset.name,
                                crate::archive::can_extract_download_archive(&asset.name),
                                platform,
                                self.package_hints,
                            )
                            .0 == PackageSuitability::Suitable
                    })
            };
            if let Some(preferred) = select_channel_candidate(
                releases,
                channel,
                rolling_tag,
                explicitly_permitted,
                is_beta_release,
                |release| &release.tag_name,
            ) {
                return Some(preferred);
            }
        }
        ordinary
    }
}
/// The largest release window one request lists (ten pages of 100).
pub(crate) const MAX_RELEASE_WINDOW: usize = 1_000;
/// GitHub allows at most 1,000 assets per release, so this inventory bound is
/// the provider's own completeness limit, not a Portcove cap.
const ASSET_LIMIT: usize = 1_000;

#[derive(Deserialize)]
pub(crate) struct CatalogGithubRepository {
    pub(crate) id: u64,
    pub(crate) full_name: String,
    private: Option<bool>,
}

impl CatalogGithubRepository {
    fn require_valid(&self, expected_id: Option<u64>) -> Result<()> {
        if portcove_listing_carrier::admitted_github_repository_id(&format!("github-{}", self.id))
            != Some(self.id)
            || expected_id.is_some_and(|expected| expected != self.id)
            || repository_from_url(&format!("https://github.com/{}", self.full_name))?
                != self.full_name
        {
            return Err(PortcoveError::verification(
                "GitHub returned a different or invalid repository identity",
            ));
        }
        Ok(())
    }
}

pub(crate) fn repository_from_url(value: &str) -> Result<String> {
    let url = reqwest::Url::parse(value).map_err(|_| {
        PortcoveError::unsupported("upstream releases require a GitHub repository URL")
    })?;
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return Err(PortcoveError::unsupported(
            "self-service downloads currently support GitHub releases",
        ));
    }
    let parts = url
        .path_segments()
        .into_iter()
        .flatten()
        .take(2)
        .collect::<Vec<_>>();
    if parts.len() != 2
        || parts.iter().any(|part| {
            part.is_empty()
                || *part == "."
                || *part == ".."
                || part.len() > 100
                || !part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
        })
    {
        return Err(PortcoveError::verification(
            "upstream URL does not identify one GitHub repository",
        ));
    }
    Ok(format!(
        "{}/{}",
        parts[0],
        parts[1].strip_suffix(".git").unwrap_or(parts[1])
    ))
}

fn valid_download_origin(url: &reqwest::Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && matches!(
            url.host_str(),
            Some(
                "github.com"
                    | "release-assets.githubusercontent.com"
                    | "objects.githubusercontent.com"
                    | "github-releases.githubusercontent.com"
            )
        )
}

impl GithubReleaseProvider {
    pub(crate) fn for_personal_project_lookup() -> Result<Self> {
        // The fixed anonymous client has no library cache or credentials.
        // Share its request budget across previews and saves in this process.
        static PROVIDER: std::sync::Mutex<Option<GithubReleaseProvider>> =
            std::sync::Mutex::new(None);
        let mut provider = PROVIDER
            .lock()
            .map_err(|_| PortcoveError::state("public GitHub lookup is unavailable"))?;
        if let Some(client) = provider.as_ref() {
            return Ok(client.clone());
        }
        let client = Self::build_with_credential(
            None,
            "https://api.github.com",
            "https://github.com",
            PROVIDER_NETWORK_BOUNDS,
            Some(GithubCredential {
                token: None,
                source: GithubAuthSource::Anonymous,
                environment_variable: None,
                intent: 0,
            }),
            false,
        )?;
        *provider = Some(client.clone());
        Ok(client)
    }

    /// Verify an explicitly supplied public project. Only the repository
    /// address is sent to GitHub; runtime coordinates stay in the caller.
    pub(crate) async fn public_catalog_repository(
        &self,
        project_url: &str,
    ) -> Result<CatalogGithubRepository> {
        let repository = repository_from_url(project_url)?;
        if !project_url
            .strip_suffix('/')
            .unwrap_or(project_url)
            .eq_ignore_ascii_case(&format!("https://github.com/{repository}"))
        {
            return Err(PortcoveError::usage(
                "enter the public GitHub project's main address",
            ));
        }
        let api_url = self.catalog_download_api_repository(&repository, None);
        let current: CatalogGithubRepository = self
            .anonymous_metadata(&api_url, 64 * 1024, "GitHub public project")
            .await?;
        current.require_valid(None)?;
        if current.private != Some(false) {
            return Err(PortcoveError::unsupported("choose a public GitHub project"));
        }
        if !current.full_name.eq_ignore_ascii_case(&repository) {
            return Err(PortcoveError::conflict(
                "this GitHub project has moved; enter its current project address",
            ));
        }
        Ok(current)
    }

    async fn catalog_repository_identity(
        &self,
        repository: &str,
        id: Option<u64>,
    ) -> Result<CatalogGithubRepository> {
        let url = self.catalog_download_api_repository(repository, id);
        let current: CatalogGithubRepository = self.get_json(&url).await?;
        current.require_valid(id)?;
        Ok(current)
    }

    /// The default ten-release window, as fixtures read it.
    #[cfg(test)]
    pub(crate) async fn catalog_download_options(
        &self,
        repository: &str,
        selected_id: Option<u64>,
        channel: ReleaseChannel,
        rolling_tag: Option<&str>,
        other_stream_prefixes: &[String],
    ) -> Result<(
        Vec<CatalogDownloadCandidate>,
        CatalogDownloadCoverage,
        Vec<crate::CatalogDownloadRelease>,
        Option<u64>,
    )> {
        self.catalog_download_options_window(
            (repository, None),
            selected_id,
            channel,
            rolling_tag,
            GithubCatalogDownloadScope {
                other_stream_prefixes,
                ..Default::default()
            },
            RELEASE_LIMIT,
        )
        .await
    }

    /// Lists the newest `window` releases (clamped to 10..=1,000), so a chooser
    /// can reach older releases by asking for a larger window.
    pub(crate) async fn catalog_download_options_window(
        &self,
        (repository, repository_id): (&str, Option<u64>),
        selected_id: Option<u64>,
        channel: ReleaseChannel,
        rolling_tag: Option<&str>,
        scope: GithubCatalogDownloadScope<'_>,
        window: usize,
    ) -> Result<(
        Vec<CatalogDownloadCandidate>,
        CatalogDownloadCoverage,
        Vec<crate::CatalogDownloadRelease>,
        Option<u64>,
    )> {
        let api_repository = self.catalog_download_api_repository(repository, repository_id);
        let window = window.clamp(RELEASE_LIMIT, MAX_RELEASE_WINDOW);
        let per_page = window.min(PROVIDER_PAGE_SIZE);
        let mut releases: Vec<GithubRelease> = Vec::new();
        let mut history_complete = false;
        for page in 1..=window.div_ceil(per_page) {
            let url = paginated_url(&api_repository, "releases", page, per_page)?;
            let current: Vec<GithubRelease> = self.get_json(&url).await?;
            if current.len() > per_page {
                return Err(PortcoveError::verification(
                    "upstream release listing exceeds its bound",
                ));
            }
            let short = current.len() < per_page;
            releases.extend(current);
            if short {
                // Whole pages can read past a window that is not a multiple of
                // the page size; history is complete only if nothing beyond the
                // window was hidden.
                history_complete = releases.len() <= window;
                break;
            }
        }
        if selected_id.is_none() && !history_complete {
            let preferred = scope.select(&releases, channel, rolling_tag, |_| true);
            // A recent stable is not proof that Preview has no older preview.
            // Reuse managed discovery's finite completeness policy only when
            // the browse window cannot establish the requested channel.
            if preferred.is_none()
                || (channel == ReleaseChannel::Beta
                    && preferred.is_some_and(|release| !is_beta_release(release)))
            {
                releases = self.releases(&api_repository).await?;
            }
        }
        if let Some(id) = selected_id {
            if id == 0 {
                return Err(PortcoveError::usage("release ID must be nonzero"));
            }
            if !releases.iter().any(|release| release.id == Some(id)) {
                let release: GithubRelease = self
                    .get_json(&format!("{api_repository}/releases/{id}"))
                    .await?;
                if release.id != Some(id) || release.draft {
                    return Err(PortcoveError::verification(
                        "selected release is not published",
                    ));
                }
                releases.push(release);
            }
        }
        let mut ids = std::collections::BTreeSet::new();
        for release in &releases {
            if release.id.is_none_or(|id| id == 0 || !ids.insert(id))
                || release.tag_name.len() > 512
                || release.tag_name.chars().any(char::is_control)
            {
                return Err(PortcoveError::verification(
                    "invalid or repeated release identity",
                ));
            }
        }
        let selected = if let Some(id) = selected_id {
            releases
                .iter()
                .find(|release| !release.draft && release.id == Some(id))
        } else {
            scope.select(&releases, channel, rolling_tag, |_| true)
        };
        let selected_id = selected.and_then(|release| release.id);
        let mut candidates = Vec::new();
        if let Some(release) = selected {
            let assets = self
                .release_assets_at(&api_repository, release.id.unwrap(), None)
                .await?;
            let repository = self
                .catalog_repository_for_assets(repository, repository_id, &assets)
                .await?;
            let mut ids = std::collections::BTreeSet::new();
            for asset in &assets {
                let candidate = self.catalog_candidate(&repository, release, asset)?;
                if !ids.insert(candidate.asset_id.clone()) {
                    return Err(PortcoveError::verification("release repeats an asset ID"));
                }
                candidates.push(candidate);
            }
        }
        let summaries = releases
            .iter()
            .enumerate()
            .filter(|(index, release)| {
                !release.draft && (*index < window || release.id == selected_id)
            })
            .map(|(_, release)| crate::CatalogDownloadRelease {
                id: release.id.unwrap().into(),
                tag: release.tag_name.clone(),
                preview: is_beta_release(release),
                assets_complete: release.id == selected_id,
            })
            .collect();
        Ok((
            candidates,
            CatalogDownloadCoverage {
                release_limit: window,
                candidate_limit: ASSET_LIMIT,
                releases_checked: usize::from(selected_id.is_some()),
                release_history_complete: history_complete,
                candidates_complete: true,
                limitations: Vec::new(),
            },
            summaries,
            selected_id,
        ))
    }

    pub(crate) fn catalog_download_client(&self, numeric_asset: bool) -> Result<reqwest::Client> {
        let mut headers = reqwest::header::HeaderMap::new();
        if numeric_asset {
            headers.insert(
                reqwest::header::ACCEPT,
                reqwest::header::HeaderValue::from_static("application/octet-stream"),
            );
        }
        #[cfg(test)]
        let fixture_origin = self.api_root.clone();
        reqwest::Client::builder()
            .default_headers(headers)
            .user_agent(concat!("Portcove/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(self.network_bounds.connect)
            .read_timeout(self.network_bounds.read_idle)
            .redirect(reqwest::redirect::Policy::custom(move |attempt| {
                if attempt.previous().len() >= 5 {
                    return attempt.error("GitHub download redirect limit exceeded");
                }
                // Numeric transfers must not redirect back to a mutable repository URL.
                let allowed = valid_download_origin(attempt.url())
                    && (!numeric_asset || attempt.url().host_str() != Some("github.com"));
                #[cfg(test)]
                let allowed = allowed || same_origin(attempt.url().as_str(), &fixture_origin);
                if allowed {
                    attempt.follow()
                } else {
                    attempt.error("GitHub download redirected outside supported release hosts")
                }
            }))
            .build()
            .map_err(|error| PortcoveError::network(error.to_string()))
    }

    fn require_catalog_asset_url(&self, repository: &str, value: &str) -> Result<()> {
        let url = reqwest::Url::parse(value)
            .map_err(|_| PortcoveError::verification("invalid GitHub release asset URL"))?;
        #[cfg(test)]
        if self.api_root.starts_with("http://127.0.0.1:") && same_origin(value, &self.api_root) {
            return Ok(());
        }
        let prefix = format!("/{repository}/releases/download/");
        if !valid_download_origin(&url)
            || url.host_str() != Some("github.com")
            || !url
                .path()
                .to_ascii_lowercase()
                .starts_with(&prefix.to_ascii_lowercase())
            || url.path().len() <= prefix.len()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(PortcoveError::verification(
                "release asset URL is outside its GitHub repository",
            ));
        }
        Ok(())
    }

    /// An existing numeric repository can acquire a new public path. Check its
    /// current provider identity before accepting asset URLs outside the
    /// authored path. Name-based callers still use only the authored path.
    async fn catalog_repository_for_assets<'a>(
        &self,
        repository: &'a str,
        repository_id: Option<u64>,
        assets: &[GithubAsset],
    ) -> Result<Cow<'a, str>> {
        let check = |name: &str| {
            assets.iter().try_for_each(|asset| {
                self.require_catalog_asset_url(name, &asset.browser_download_url)
            })
        };
        match (check(repository), repository_id) {
            (Ok(()), _) => return Ok(Cow::Borrowed(repository)),
            (Err(error), None) => return Err(error),
            (Err(_), Some(_)) => {}
        }
        let current = self
            .catalog_repository_identity(repository, repository_id)
            .await?;
        check(&current.full_name)?;
        Ok(Cow::Owned(current.full_name))
    }

    pub(super) fn catalog_candidate(
        &self,
        repository: &str,
        release: &GithubRelease,
        asset: &GithubAsset,
    ) -> Result<CatalogDownloadCandidate> {
        self.require_catalog_asset_url(repository, &asset.browser_download_url)?;
        crate::archive::validate_relative_path(&asset.name, false)?;
        if asset.name.contains(['/', '\\'])
            || asset.name.len() > 255
            || asset.name.to_ascii_lowercase().starts_with(".portcove-")
        {
            return Err(PortcoveError::verification(
                "release asset must have a safe single-component filename",
            ));
        }
        crate::archive::validate_download_progress(0, asset.size)?;
        if asset.size == 0
            || release.tag_name.is_empty()
            || release.tag_name.len() > 512
            || release.tag_name.chars().any(char::is_control)
        {
            return Err(PortcoveError::verification(
                "release asset metadata is empty or exceeds its bound",
            ));
        }
        let sha256 = match asset.digest.as_deref() {
            None => None,
            Some(digest) => Some(parse_digest(digest).ok_or_else(|| {
                PortcoveError::verification(
                    "upstream asset digest is malformed or uses an unsupported algorithm",
                )
            })?),
        };
        Ok(CatalogDownloadCandidate {
            release_id: release
                .id
                .filter(|id| *id > 0)
                .ok_or_else(|| PortcoveError::verification("release has no stable ID"))?
                .into(),
            asset_id: asset
                .id
                .filter(|id| *id > 0)
                .ok_or_else(|| PortcoveError::verification("release asset has no stable ID"))?
                .into(),
            release_tag: release.tag_name.clone(),
            release_url: catalog_release_page(repository, &release.tag_name)?,
            name: asset.name.clone(),
            size: asset.size,
            download_url: asset.browser_download_url.clone(),
            sha256,
            can_extract: crate::archive::can_extract_download_archive(&asset.name),
        })
    }

    pub(crate) fn numeric_catalog_asset_url(&self, repository_id: u64, asset_id: u64) -> String {
        format!(
            "{}/repositories/{repository_id}/releases/assets/{asset_id}",
            self.api_root
        )
    }

    fn catalog_download_api_repository(&self, repository: &str, id: Option<u64>) -> String {
        match id {
            Some(id) => format!("{}/repositories/{id}", self.api_root),
            None => format!("{}/repos/{repository}", self.api_root),
        }
    }

    pub(super) async fn release_assets_scoped(
        &self,
        repository: &str,
        release_id: u64,
        scope: Option<&crate::DefinitionAcquisitionScope>,
    ) -> Result<Vec<GithubAsset>> {
        let api_repository = self.catalog_download_api_repository(repository, None);
        self.release_assets_at(&api_repository, release_id, scope)
            .await
    }

    async fn release_assets_at(
        &self,
        api_repository: &str,
        release_id: u64,
        scope: Option<&crate::DefinitionAcquisitionScope>,
    ) -> Result<Vec<GithubAsset>> {
        let root = format!("{api_repository}/releases/{release_id}");
        let mut assets = Vec::new();
        // One page past GitHub's 1,000-asset maximum confirms the end of a full
        // inventory; anything on it exceeds the provider's own bound.
        for page in 1..=GITHUB_ASSET_INVENTORY_PAGE_LIMIT + 1 {
            let url = paginated_url(&root, "assets", page, 100)?;
            let current: Vec<GithubAsset> = match scope {
                Some(scope) => self.scoped_json(&url, scope).await?,
                None => self.get_json(&url).await?,
            };
            if current.len() > 100 || assets.len() + current.len() > ASSET_LIMIT {
                return Err(PortcoveError::verification(
                    "selected release exceeds GitHub's 1,000-asset release inventory",
                ));
            }
            let complete = current.len() < 100;
            assets.extend(current);
            if complete {
                return Ok(assets);
            }
        }
        Err(PortcoveError::verification(
            "selected release asset inventory is incomplete",
        ))
    }

    async fn catalog_release_asset(
        &self,
        repository: &str,
        release_id: u64,
        asset_id: u64,
        repository_id: Option<u64>,
    ) -> Result<(GithubRelease, usize)> {
        if release_id == 0 || asset_id == 0 {
            return Err(PortcoveError::usage(
                "release and asset IDs must be nonzero",
            ));
        }
        // Verify the exact immutable IDs against the configured repository.
        let api_repository = self.catalog_download_api_repository(repository, repository_id);
        let url = format!("{api_repository}/releases/{release_id}");
        let mut release: GithubRelease = self.get_json(&url).await?;
        if release.id != Some(release_id) || release.draft || release.assets.len() > ASSET_LIMIT {
            return Err(PortcoveError::verification(
                "selected release changed or is not a published bounded release",
            ));
        }
        // GitHub embeds only a partial asset collection on some release reads.
        // Sidecar absence is meaningful only after the dedicated collection has
        // been read to its bounded end.
        release.assets = self
            .release_assets_at(&api_repository, release_id, None)
            .await?;
        let mut matching = release
            .assets
            .iter()
            .enumerate()
            .filter(|(_, asset)| asset.id == Some(asset_id));
        let (asset_index, _) = matching.next().ok_or_else(|| {
            PortcoveError::not_found("selected release asset is no longer available")
        })?;
        if matching.next().is_some() {
            return Err(PortcoveError::verification(
                "release repeats the selected asset ID",
            ));
        }
        Ok((release, asset_index))
    }

    pub(crate) async fn catalog_release_notes_url(
        &self,
        repository: &str,
        release_id: u64,
        asset_id: u64,
        repository_id: Option<u64>,
    ) -> Result<(String, Option<String>)> {
        let (release, asset_index) = self
            .catalog_release_asset(repository, release_id, asset_id, repository_id)
            .await?;
        let current_repository = self
            .catalog_repository_for_assets(
                repository,
                repository_id,
                std::slice::from_ref(&release.assets[asset_index]),
            )
            .await?;
        let previous = (!current_repository.eq_ignore_ascii_case(repository))
            .then(|| catalog_release_page(repository, &release.tag_name))
            .transpose()?;
        Ok((
            catalog_release_page(&current_repository, &release.tag_name)?,
            previous,
        ))
    }

    pub(crate) async fn catalog_release_candidate(
        &self,
        repository: &str,
        release_id: u64,
        asset_id: u64,
        repository_id: Option<u64>,
    ) -> Result<CatalogDownloadCandidate> {
        let (release, asset_index) = self
            .catalog_release_asset(repository, release_id, asset_id, repository_id)
            .await?;
        let asset = &release.assets[asset_index];
        let current_repository = self
            .catalog_repository_for_assets(repository, repository_id, &release.assets)
            .await?;
        let mut candidate = self.catalog_candidate(&current_repository, &release, asset)?;
        // Existing bounded sidecar parsing remains the checksum authority. Its
        // requests use the same restricted, unauthenticated release transport.
        let mut guarded = self.clone();
        guarded.download_client = self.catalog_download_client(repository_id.is_some())?;
        let numeric_sidecars = if let Some(repository_id) = repository_id {
            let (_, sidecars) = checksum_sidecars(&release.assets, asset)?;
            Some(
                sidecars
                    .into_iter()
                    .map(|sidecar| {
                        let mut sidecar = sidecar.clone();
                        let id = sidecar.id.filter(|id| *id > 0).ok_or_else(|| {
                            PortcoveError::verification("release checksum asset has no stable ID")
                        })?;
                        sidecar.browser_download_url =
                            self.numeric_catalog_asset_url(repository_id, id);
                        Ok(sidecar)
                    })
                    .collect::<Result<Vec<_>>>()?,
            )
        } else {
            None
        };
        let checksum_assets = numeric_sidecars.as_deref().unwrap_or(&release.assets);
        let sidecar = tokio::time::timeout(
            self.network_bounds.request,
            guarded.checksum_from_sidecar(checksum_assets, asset),
        )
        .await
        .map_err(|_| PortcoveError::network("upstream checksum metadata request timed out"))??;
        if sidecar.is_none()
            && release.assets.iter().any(|other| {
                other
                    .name
                    .eq_ignore_ascii_case(&format!("{}.sha256", asset.name))
            })
        {
            return Err(PortcoveError::verification(
                "upstream supplied a checksum sidecar without a valid SHA-256 for this asset",
            ));
        }
        if let (Some(digest), Some(sidecar)) = (&candidate.sha256, &sidecar)
            && !digest.eq_ignore_ascii_case(sidecar)
        {
            return Err(PortcoveError::verification(
                "upstream asset digest conflicts with its checksum sidecar",
            ));
        }
        candidate.sha256 = candidate.sha256.or(sidecar);
        Ok(candidate)
    }
}

fn catalog_release_page(repository: &str, tag: &str) -> Result<String> {
    if tag.is_empty() || tag.len() > 512 || tag.chars().any(char::is_control) {
        return Err(PortcoveError::verification(
            "release tag is empty or exceeds its bound",
        ));
    }
    let url = format!("https://github.com/{repository}/releases/tag/");
    crate::release_notes::web_url(&url, &[tag])
        .ok_or_else(|| PortcoveError::verification("invalid GitHub release URL"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_http::serve_http;

    fn response(body: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    fn history(first: u64, count: u64) -> String {
        serde_json::to_string(&(first..first + count).map(|id| serde_json::json!({
            "id":id,"tag_name":format!("v{id}"),"draft":false,"prerelease":false,"published_at":null,"assets":[]
        })).collect::<Vec<_>>()).unwrap()
    }

    #[test]
    fn reviewed_default_keeps_the_channel_and_host_of_the_suggested_download() {
        let hash = "a".repeat(64);
        let listing: crate::PortListing = serde_json::from_value(serde_json::json!({
            "id":"shared-release-fixture","name":"Shared release fixture",
            "summary":"Separate native packages","project_url":"https://github.com/owner/game",
            "release_url":"https://github.com/owner/game/releases","platforms":[],
            "restrictions":[
                {"id":"feed-hold","effect":"hold","operations":["download"],
                 "reason":"package-facts-unresolved","explanation":"Use the reviewed package."},
                {"id":"reviewed","effect":"permit","operations":["download"],"scope":{"artifacts":[
                    {"version":"v3.0","sha256":hash,"asset_name":"game-windows-x64.zip"},
                    {"version":"v2.0","sha256":hash,"asset_name":"game-linux-x64.zip"}
                ]}}
            ]
        }))
        .unwrap();
        let rules = EffectiveRestrictions::listing_only(&listing);
        let scope = GithubCatalogDownloadScope {
            reviewed: Some((&rules, Platform::LinuxX86_64)),
            ..Default::default()
        };
        let release = |id, tag, prerelease, name: &str| -> GithubRelease {
            serde_json::from_value(serde_json::json!({
                "id":id,"tag_name":tag,"draft":false,"prerelease":prerelease,
                "assets":[{"id":id,"name":name,"size":1,"browser_download_url":"unused",
                           "digest":format!("sha256:{hash}")}]
            }))
            .unwrap()
        };
        let mut releases = [
            release(4, "v4.0-beta", true, "game-linux-x64.zip"),
            release(3, "v3.0", false, "game-windows-x64.zip"),
            release(2, "v2.0", false, "game-linux-x64.zip"),
        ];
        assert_eq!(
            scope
                .select(&releases, ReleaseChannel::Stable, None, |_| true)
                .unwrap()
                .id,
            Some(2)
        );
        assert_eq!(
            scope
                .select(&releases, ReleaseChannel::Beta, None, |_| true)
                .unwrap()
                .id,
            Some(4)
        );
        // A partial signed release may not displace the normal default.
        assert_eq!(
            scope
                .select(&releases, ReleaseChannel::Stable, None, |r| r.id != Some(2))
                .unwrap()
                .id,
            Some(3)
        );
        // GitHub can omit inline assets. Keep ordinary browsing and let the
        // selected release's own asset request apply the exact file gate.
        releases[2].assets.clear();
        assert_eq!(
            scope
                .select(&releases, ReleaseChannel::Stable, None, |_| true)
                .unwrap()
                .id,
            Some(3)
        );
    }

    #[tokio::test]
    async fn incomplete_or_failed_channel_observation_never_becomes_preview_fallback() {
        for failure in ["rate", "network", "bound"] {
            let mut responses = vec![response(&history(1, 10))];
            match failure {
                "rate" => responses.push("HTTP/1.1 403 Forbidden\r\nx-ratelimit-limit: 60\r\nx-ratelimit-remaining: 0\r\nx-ratelimit-reset: 2000000000\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into()),
                "network" => responses.push("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into()),
                // A long stable history keeps being read; a failure after the
                // former 1,000-release bound is still never a preview fallback.
                _ => {
                    for page in 0..GITHUB_MAX_RELEASE_PAGES { responses.push(response(&history((page * PROVIDER_PAGE_SIZE + 1) as u64, PROVIDER_PAGE_SIZE as u64))); }
                    responses.push("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into());
                }
            }
            let count = responses.len();
            let (root, requests, server) = serve_http(responses);
            let provider = GithubReleaseProvider::with_api_root(root).unwrap();
            let error = provider
                .catalog_download_options("owner/game", None, ReleaseChannel::Beta, None, &[])
                .await
                .unwrap_err();
            assert_eq!(error.code, crate::ErrorCode::Network, "{failure}: {error}");
            if failure == "rate" {
                assert_eq!(
                    error.details.get("rate_remaining").map(String::as_str),
                    Some("0")
                );
                assert_eq!(
                    error.presentation().presentation_key,
                    "provider_rate_limited"
                );
            }
            server.join().unwrap();
            assert_eq!(requests.try_iter().count(), count);
        }
    }

    #[tokio::test]
    async fn default_download_follows_the_reviewed_desktop_stream() {
        let headers = serde_json::json!([
            {"id":446416764,"tag_name":"baked-pbr-v1","draft":false,"prerelease":false,"assets":[]},
            {"id":443250877,"tag_name":"v0.9.9","draft":false,"prerelease":false,"assets":[]},
            {"id":435773723,"tag_name":"baked-ao-v1","draft":false,"prerelease":false,"assets":[]}
        ]);
        let exclusions = ["baked-ao-".into(), "baked-pbr-".into()];
        for (requested, expected) in [(None, 443250877), (Some(446416764), 446416764)] {
            let (root, requests, server) =
                serve_http(vec![response(&headers.to_string()), response("[]")]);
            let provider = GithubReleaseProvider::with_api_root(root).unwrap();
            let (_, _, summaries, selected) = provider
                .catalog_download_options(
                    "Inkub0/dude",
                    requested,
                    ReleaseChannel::Stable,
                    None,
                    &exclusions,
                )
                .await
                .unwrap();
            assert_eq!(selected, Some(expected));
            assert_eq!(summaries.len(), 3);
            server.join().unwrap();
            let paths = requests.try_iter().collect::<Vec<_>>();
            assert_eq!(paths.len(), 2);
            assert!(paths[1].contains(&format!("/releases/{expected}/assets?")));
        }
    }

    #[tokio::test]
    async fn explicit_historical_selection_never_becomes_channel_latest() {
        let exact = serde_json::json!({"id":500,"tag_name":"chosen-old-build","draft":false,"prerelease":false,"published_at":null,"assets":[]});
        let (root, requests, server) = serve_http(vec![
            response(&history(1, 10)),
            response(&exact.to_string()),
            response("[]"),
        ]);
        let provider = GithubReleaseProvider::with_api_root(root).unwrap();
        let (_, coverage, summaries, selected) = provider
            .catalog_download_options("owner/game", Some(500), ReleaseChannel::Beta, None, &[])
            .await
            .unwrap();
        assert_eq!(selected, Some(500));
        assert_eq!(summaries.last().unwrap().tag, "chosen-old-build");
        assert!(!coverage.release_history_complete);
        server.join().unwrap();
        let paths = requests.try_iter().collect::<Vec<_>>();
        assert_eq!(paths.len(), 3);
        assert!(paths[1].contains("/releases/500 "));
        assert!(paths[2].contains("/releases/500/assets?"));
    }
    #[tokio::test]
    async fn a_larger_window_lists_releases_beyond_the_first_ten() {
        // Twenty-five published releases: the default window shows ten, a
        // 35-release window reads them all and reaches the end of history.
        let (root, requests, server) = serve_http(vec![response(&history(1, 25)), response("[]")]);
        let provider = GithubReleaseProvider::with_api_root(root).unwrap();
        let (_, coverage, summaries, _) = provider
            .catalog_download_options_window(
                ("owner/game", None),
                None,
                ReleaseChannel::Stable,
                None,
                GithubCatalogDownloadScope::default(),
                35,
            )
            .await
            .unwrap();
        server.join().unwrap();
        assert_eq!(summaries.len(), 25);
        assert_eq!(summaries.last().unwrap().tag, "v25");
        assert!(coverage.release_history_complete);
        assert_eq!(coverage.release_limit, 35);
        let paths = requests.try_iter().collect::<Vec<_>>();
        assert!(paths[0].contains("per_page=35"), "{}", paths[0]);
    }

    #[tokio::test]
    async fn a_window_between_page_sizes_never_hides_releases_as_complete() {
        // 150 releases read with a 110-release window: two full-size pages
        // return 150, so 40 lie beyond the window and history is not complete.
        let (root, _requests, server) = serve_http(vec![
            response(&history(1, 100)),
            response(&history(101, 50)),
            response("[]"),
        ]);
        let provider = GithubReleaseProvider::with_api_root(root).unwrap();
        let (_, coverage, summaries, _) = provider
            .catalog_download_options_window(
                ("owner/game", None),
                None,
                ReleaseChannel::Stable,
                None,
                GithubCatalogDownloadScope::default(),
                110,
            )
            .await
            .unwrap();
        server.join().unwrap();
        assert_eq!(summaries.len(), 110);
        assert!(!coverage.release_history_complete);
    }

    #[tokio::test]
    async fn a_selected_release_with_more_than_two_hundred_assets_is_listed_whole() {
        let page = |first: u64, count: u64| {
            let assets = (first..first + count)
                .map(|id| serde_json::json!({
                    "id": id,
                    "name": format!("game-{id}.zip"),
                    "browser_download_url": format!("https://github.com/owner/game/releases/download/v1/game-{id}.zip"),
                    "size": 1
                }))
                .collect::<Vec<_>>();
            response(&serde_json::to_string(&assets).unwrap())
        };
        let (root, _requests, server) = serve_http(vec![
            response(&history(1, 1)),
            page(1, 100),
            page(101, 100),
            page(201, 50),
        ]);
        let provider = GithubReleaseProvider::with_api_root(root).unwrap();
        let (candidates, coverage, _, _) = provider
            .catalog_download_options("owner/game", None, ReleaseChannel::Stable, None, &[])
            .await
            .unwrap();
        server.join().unwrap();
        assert_eq!(candidates.len(), 250);
        assert!(
            candidates
                .iter()
                .any(|candidate| candidate.name == "game-250.zip")
        );
        assert_eq!(coverage.candidate_limit, 1_000);
    }

    #[test]
    fn repository_boundary_does_not_become_a_universal_fetcher() {
        assert_eq!(
            repository_from_url("https://github.com/owner/game/releases").unwrap(),
            "owner/game"
        );
        for url in [
            "http://github.com/owner/game",
            "https://example.com/owner/game",
            "https://user@github.com/owner/game",
            "https://github.com/owner",
            "https://github.com/owner/%2e%2e",
        ] {
            assert!(repository_from_url(url).is_err(), "{url}");
        }
    }

    #[tokio::test]
    async fn personal_project_lookup_requires_a_public_exact_repository_root() {
        let (root, requests, server) = crate::test_http::serve_routed_http(4, |request| {
            let path = request.split_whitespace().nth(1).unwrap();
            let body = match path.strip_prefix('/').unwrap() {
                "repos/Owner/Public" => r#"{"id":42,"full_name":"Owner/Public","private":false}"#,
                "repos/Owner/Private" => r#"{"id":43,"full_name":"Owner/Private","private":true}"#,
                "repos/Owner/Moved" => r#"{"id":42,"full_name":"Owner/Public","private":false}"#,
                "repos/Owner/Unknown" => r#"{"id":44,"full_name":"Owner/Unknown"}"#,
                _ => panic!("the lookup requested something other than repository metadata"),
            };
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
        });
        let provider = GithubReleaseProvider::with_api_root(root).unwrap();
        for address in [
            "https://github.com/Owner/Public/releases",
            "https://github.com/Owner/other/../Public",
            "https://github.com/Owner/Public?token=fixture",
            "https://github.com/Owner/Public.git",
        ] {
            assert!(provider.public_catalog_repository(address).await.is_err());
        }
        assert!(requests.try_recv().is_err());
        let identity = provider
            .public_catalog_repository("https://github.com/Owner/Public/")
            .await
            .unwrap();
        assert_eq!(
            (identity.id, identity.full_name.as_str()),
            (42, "Owner/Public")
        );
        for (name, code) in [
            ("Private", crate::ErrorCode::Unsupported),
            ("Moved", crate::ErrorCode::Conflict),
            ("Unknown", crate::ErrorCode::Unsupported),
        ] {
            let address = format!("https://github.com/Owner/{name}");
            let refusal = provider
                .public_catalog_repository(&address)
                .await
                .err()
                .expect("an ineligible repository must be refused");
            assert_eq!(refusal.code, code, "{name}");
        }
        // The fixture sends the request receipt after writing the response.
        server.join().unwrap();
        let sent = requests.try_iter().collect::<Vec<_>>();
        assert_eq!(sent.len(), 4);
        assert!(sent.iter().all(|request| {
            !request.lines().any(|line| {
                line.split_once(':')
                    .is_some_and(|(header, _)| header.eq_ignore_ascii_case("authorization"))
            })
        }));
    }
}
