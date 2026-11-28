//! Reuse the existing descriptive directory for preliminary browsing only.
//! Preview and acquisition still read the selected exact upstream artifact.
use super::*;
use crate::{CatalogDownloadCandidate, CatalogDownloadCoverage, CatalogDownloadRelease};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

type ObservedOptions = (
    Vec<CatalogDownloadCandidate>,
    CatalogDownloadCoverage,
    Vec<CatalogDownloadRelease>,
    Option<u64>,
);

impl GithubReleaseProvider {
    pub(crate) fn observed_catalog_download_options(
        &self,
        listing: &crate::PortListing,
        selected: Option<&crate::CatalogDownloadReleaseId>,
        channel: ReleaseChannel,
        rolling_tag: Option<&str>,
        scope: GithubCatalogDownloadScope<'_>,
        now: OffsetDateTime,
    ) -> Option<ObservedOptions> {
        // Enrichment cannot make a broken optional observation a new prerequisite.
        listing.validate().ok()?;
        let observation = listing.upstream_observation.as_ref()?;
        if observation.provider != "github"
            || observation.status != crate::ListingObservationStatus::Complete
        {
            return None;
        }
        let observed = OffsetDateTime::parse(observation.observed_at.as_ref()?, &Rfc3339).ok()?;
        let expires = OffsetDateTime::parse(observation.fresh_until.as_ref()?, &Rfc3339).ok()?;
        if now < observed || now >= expires {
            return None;
        }
        let releases = observation
            .releases
            .iter()
            .map(|release| {
                Some(GithubRelease {
                    id: Some(release.id.github_id()?),
                    tag_name: release.version.clone(),
                    name: None,
                    body: None,
                    draft: false,
                    prerelease: release.provider_prerelease,
                    published_at: Some(release.published_at.clone()),
                    assets: release
                        .assets
                        .iter()
                        .map(|asset| GithubAsset {
                            id: Some(asset.id),
                            name: asset.name.clone(),
                            browser_download_url: asset.url.clone(),
                            size: asset.size,
                            digest: asset.sha256.as_ref().map(|hash| format!("sha256:{hash}")),
                            uploader: Default::default(),
                            created_at: None,
                        })
                        .collect(),
                })
            })
            .collect::<Option<Vec<_>>>()?;
        let chosen = match selected {
            Some(id) => releases.iter().find(|release| release.id == id.github_id()),
            None => scope.select(&releases, channel, rolling_tag, |release| {
                observation.releases.iter().any(|observed| {
                    observed.id.github_id() == release.id && observed.assets_complete
                })
            }),
        }?;
        // A bounded window cannot establish that no older preview exists.
        if selected.is_none() && channel == ReleaseChannel::Beta && !is_beta_release(chosen) {
            return None;
        }
        let chosen_observation = observation
            .releases
            .iter()
            .find(|release| release.id.github_id() == chosen.id)?;
        if !chosen_observation.assets_complete {
            return None;
        }
        let candidates = chosen
            .assets
            .iter()
            .map(|asset| self.catalog_candidate(&observation.repository, chosen, asset))
            .collect::<Result<Vec<_>>>()
            .ok()?;
        let summaries = releases
            .iter()
            .zip(&observation.releases)
            .map(|(release, observed)| CatalogDownloadRelease {
                id: observed.id.clone(),
                tag: release.tag_name.clone(),
                preview: is_beta_release(release),
                assets_complete: observed.assets_complete,
            })
            .collect();
        Some((
            candidates,
            CatalogDownloadCoverage {
                release_limit: observation.release_limit,
                candidate_limit: 32,
                releases_checked: 1,
                // The descriptive window never asserts complete provider history.
                release_history_complete: false,
                candidates_complete: true,
                limitations: Vec::new(),
            },
            summaries,
            chosen.id,
        ))
    }
}
