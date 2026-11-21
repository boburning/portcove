//! Explicit, read-only upstream browsing for reviewed Quake engines.
use reqwest::Url;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    ModDbFileNotice, Observed, Platform, PortDefinition, PortcoveError, PortcoveService,
    ProviderFreshness, QuaddictedPage, Result, moddb_feed, provider_http::ProviderHttp, quaddicted,
};

/// Provider-attributed Arcane Dimensions file notices, including nonrelease notices.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ModDbFileNotices {
    pub port_id: String,
    pub platform: Platform,
    pub attribution: String,
    pub source_url: String,
    pub notices: Vec<ModDbFileNotice>,
}

pub(crate) fn has_moddb_notices(port: &PortDefinition, platform: Platform) -> bool {
    port.id == moddb_feed::PORT_ID
        && quaddicted::source(port, platform) == Some(crate::QuakeEngine::VkQuake)
}

impl PortcoveService {
    /// Lists upstream Quake content with provider attribution and no acquisition authority.
    pub async fn quaddicted_catalog(
        &self,
        port_id: &str,
        platform: Platform,
        filename_search: Option<&str>,
        page: u32,
    ) -> Result<Observed<QuaddictedPage>> {
        let port = self.catalog().port(port_id)?;
        self.quaddicted_reader()?
            .browse(port, platform, filename_search, page)
            .await
    }

    /// Revalidates an exact Quaddicted display page before a client opens it.
    pub async fn review_quaddicted_page(
        &self,
        port_id: &str,
        platform: Platform,
        page_url: &str,
    ) -> Result<String> {
        let port = self.catalog().port(port_id)?;
        self.quaddicted_reader()?
            .review_page(port, platform, page_url)
            .await
    }

    fn quaddicted_reader(&self) -> Result<quaddicted::QuaddictedReader> {
        let library = self.library();
        let http = ProviderHttp::new(Some(library.clone()), "Quaddicted", "quaddicted.com")?
            .with_backoff(library.quaddicted_backoff.clone());
        Ok(quaddicted::QuaddictedReader::new(http))
    }

    /// Returns notices from the exact reviewed Arcane Dimensions Files channel.
    pub async fn moddb_file_notices(
        &self,
        port_id: &str,
        platform: Platform,
    ) -> Result<Observed<ModDbFileNotices>> {
        let port = self.catalog().port(port_id)?;
        require_moddb_notices(port, platform)?;
        let library = self.library();
        let http = ProviderHttp::new(Some(library.clone()), "Mod DB", "moddb.com")?
            .with_backoff(library.moddb_backoff.clone());
        let feed = Url::parse(moddb_feed::FEED_URL)
            .map_err(|error| PortcoveError::state(error.to_string()))?;
        http.observe_bytes(feed, moddb_feed::MAX_BODY_BYTES, |body| {
            let notices = moddb_feed::parse_files(body).map_err(PortcoveError::verification)?;
            Ok(ModDbFileNotices {
                port_id: port_id.into(),
                platform,
                attribution: moddb_feed::ATTRIBUTION.into(),
                source_url: moddb_feed::FILES_PAGE.into(),
                notices,
            })
        })
        .await
    }

    /// Revalidates a file notice against the exact scoped provider channel.
    pub async fn review_moddb_notice(
        &self,
        port_id: &str,
        platform: Platform,
        page_url: &str,
    ) -> Result<String> {
        require_moddb_notices(self.catalog().port(port_id)?, platform)?;
        if page_url == moddb_feed::FILES_PAGE {
            return Ok(page_url.into());
        }
        // Refuse unknown link families before making a network call.
        if !moddb_feed::valid_notice_url(page_url) {
            return Err(PortcoveError::verification(
                "the page is outside the reviewed Mod DB files collection",
            ));
        }
        let notices = self.moddb_file_notices(port_id, platform).await?;
        if notices.freshness == ProviderFreshness::Stale
            || !notices
                .value
                .notices
                .iter()
                .any(|notice| notice.page_url == page_url)
        {
            return Err(PortcoveError::verification(
                "Mod DB did not confirm this reviewed notice",
            ));
        }
        Ok(page_url.into())
    }
}

fn require_moddb_notices(port: &PortDefinition, platform: Platform) -> Result<()> {
    if !has_moddb_notices(port, platform) {
        return Err(PortcoveError::unsupported(
            "this platform has no reviewed Mod DB files collection",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn exact_source_fallback_and_unsafe_links_are_scoped_before_network() {
        let root = tempfile::tempdir().unwrap();
        let library = crate::Library::open(root.path()).unwrap();
        let service = PortcoveService::new_read_only(library).unwrap();
        let windows = Platform::WindowsX86_64;
        assert_eq!(
            service
                .review_quaddicted_page("quake-ironwail", windows, quaddicted::DIRECTORY)
                .await
                .unwrap(),
            quaddicted::DIRECTORY
        );
        assert_eq!(
            service
                .review_moddb_notice("quake-vkquake", windows, moddb_feed::FILES_PAGE)
                .await
                .unwrap(),
            moddb_feed::FILES_PAGE
        );
        assert!(
            service
                .review_moddb_notice("quake-ironwail", windows, moddb_feed::FILES_PAGE)
                .await
                .is_err()
        );
        assert!(
            service
                .review_quaddicted_page(
                    "quake-vkquake",
                    windows,
                    "https://www.quaddicted.com/filebase/package.zip"
                )
                .await
                .is_err()
        );
        assert!(
            service
                .review_moddb_notice(
                    "quake-vkquake",
                    windows,
                    "https://www.moddb.com/mods/arcane-dimensions/downloads/not-an-exact-link?x=1"
                )
                .await
                .is_err()
        );
    }
}
