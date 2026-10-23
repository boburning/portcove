//! Explicit selection from bounded GitHub release metadata. This does not resolve
//! managed runtime definitions or turn descriptive platform labels into grants.
use super::*;
use crate::{CatalogDownloadCandidate, CatalogDownloadCoverage};

const RELEASE_LIMIT: usize = 10;
const ASSET_LIMIT: usize = 200;

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
    pub(crate) fn catalog_download_client(&self) -> Result<reqwest::Client> {
        #[cfg(test)]
        let fixture_origin = self.api_root.clone();
        reqwest::Client::builder()
            .user_agent(concat!("Portcove/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(self.network_bounds.connect)
            .read_timeout(self.network_bounds.read_idle)
            .redirect(reqwest::redirect::Policy::custom(move |attempt| {
                if attempt.previous().len() >= 5 {
                    return attempt.error("GitHub download redirect limit exceeded");
                }
                let allowed = valid_download_origin(attempt.url());
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

    fn catalog_candidate(
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
        let mut release_url =
            reqwest::Url::parse(&format!("https://github.com/{repository}/releases/tag/"))
                .map_err(|_| PortcoveError::verification("invalid GitHub repository"))?;
        release_url
            .path_segments_mut()
            .map_err(|_| PortcoveError::verification("invalid GitHub release URL"))?
            .pop_if_empty()
            .push(&release.tag_name);
        let lower = asset.name.to_ascii_lowercase();
        Ok(CatalogDownloadCandidate {
            release_id: release
                .id
                .filter(|id| *id > 0)
                .ok_or_else(|| PortcoveError::verification("release has no stable ID"))?,
            asset_id: asset
                .id
                .filter(|id| *id > 0)
                .ok_or_else(|| PortcoveError::verification("release asset has no stable ID"))?,
            release_tag: release.tag_name.clone(),
            release_url: release_url.into(),
            name: asset.name.clone(),
            size: asset.size,
            download_url: asset.browser_download_url.clone(),
            sha256,
            can_extract: lower.ends_with(".zip")
                || lower.ends_with(".tar.gz")
                || lower.ends_with(".tgz"),
        })
    }

    pub(crate) async fn catalog_release_candidates(
        &self,
        repository: &str,
    ) -> Result<(Vec<CatalogDownloadCandidate>, CatalogDownloadCoverage)> {
        let url = paginated_url(
            &format!("{}/repos/{repository}", self.api_root),
            "releases",
            1,
            RELEASE_LIMIT,
        )?;
        let releases: Vec<GithubRelease> = self.get_json(&url).await?;
        if releases.len() > RELEASE_LIMIT {
            return Err(PortcoveError::verification(
                "upstream release listing exceeds its bound",
            ));
        }
        let mut candidates = Vec::new();
        let mut coverage = CatalogDownloadCoverage {
            release_limit: RELEASE_LIMIT,
            candidate_limit: ASSET_LIMIT,
            releases_checked: 0,
            // A full first page cannot establish whether older releases exist.
            // Keep this explicit instead of fetching an unbounded history.
            release_history_complete: releases.len() < RELEASE_LIMIT,
            candidates_complete: true,
        };
        for release in releases.iter().filter(|release| !release.draft) {
            if candidates.len() == ASSET_LIMIT {
                coverage.candidates_complete = false;
                break;
            }
            let release_id = release
                .id
                .filter(|id| *id > 0)
                .ok_or_else(|| PortcoveError::verification("release has no stable ID"))?;
            let assets = self.catalog_release_assets(repository, release_id).await?;
            coverage.releases_checked += 1;
            let remaining = ASSET_LIMIT - candidates.len();
            coverage.candidates_complete = assets.len() <= remaining;
            for asset in assets.iter().take(remaining) {
                candidates.push(self.catalog_candidate(repository, release, asset)?);
            }
            if !coverage.candidates_complete {
                break;
            }
        }
        Ok((candidates, coverage))
    }

    async fn catalog_release_assets(
        &self,
        repository: &str,
        release_id: u64,
    ) -> Result<Vec<GithubAsset>> {
        let root = format!("{}/repos/{repository}/releases/{release_id}", self.api_root);
        let mut assets = Vec::new();
        for page in 1..=3 {
            let url = paginated_url(&root, "assets", page, 100)?;
            let current: Vec<GithubAsset> = self.get_json(&url).await?;
            if current.len() > 100 || assets.len() + current.len() > ASSET_LIMIT {
                return Err(PortcoveError::verification(
                    "selected release exceeds the complete 200-asset inventory bound",
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

    pub(crate) async fn catalog_release_candidate(
        &self,
        repository: &str,
        release_id: u64,
        asset_id: u64,
    ) -> Result<CatalogDownloadCandidate> {
        if release_id == 0 || asset_id == 0 {
            return Err(PortcoveError::usage(
                "release and asset IDs must be nonzero",
            ));
        }
        // Refresh the exact immutable IDs for every preview and execution. Never
        // accept a URL, size or checksum supplied by the caller.
        let url = format!("{}/repos/{repository}/releases/{release_id}", self.api_root);
        let mut release: GithubRelease = self.get_json(&url).await?;
        if release.id != Some(release_id) || release.draft || release.assets.len() > ASSET_LIMIT {
            return Err(PortcoveError::verification(
                "selected release changed or is not a published bounded release",
            ));
        }
        // GitHub embeds only a partial asset collection on some release reads.
        // Sidecar absence is meaningful only after the dedicated collection has
        // been read to its bounded end.
        release.assets = self.catalog_release_assets(repository, release_id).await?;
        let mut matching = release
            .assets
            .iter()
            .filter(|asset| asset.id == Some(asset_id));
        let asset = matching.next().ok_or_else(|| {
            PortcoveError::not_found("selected release asset is no longer available")
        })?;
        if matching.next().is_some() {
            return Err(PortcoveError::verification(
                "release repeats the selected asset ID",
            ));
        }
        let mut candidate = self.catalog_candidate(repository, &release, asset)?;
        // Existing bounded sidecar parsing remains the checksum authority. Its
        // requests use the same restricted, unauthenticated release transport.
        for other in &release.assets {
            self.require_catalog_asset_url(repository, &other.browser_download_url)?;
        }
        let mut guarded = self.clone();
        guarded.download_client = self.catalog_download_client()?;
        let sidecar = tokio::time::timeout(
            self.network_bounds.request,
            guarded.checksum_from_sidecar(&release.assets, asset),
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

#[cfg(test)]
mod tests {
    use super::*;
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
}
