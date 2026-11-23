//! Upstream-owned mod websites a definition declares. These grant no download,
//! import or install capability; the player manages files outside Portcove.
use crate::{Catalog, ModPortalSite, ModSourceAuthority, ModSourceKind, Platform, PortDefinition};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// The site family a portal belongs to, for its link label.
#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ExternalModSite {
    NexusMods,
    ModIo,
    ModDb,
    Quaddicted,
    CommunitySite,
}

/// A read-only provider browser Core can run for a portal.
#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ExternalModBrowser {
    Quaddicted,
    ModDbFeed,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ExternalModPortal {
    /// The declared source ID. Clients pass it back to open a page.
    pub source: String,
    pub site: ExternalModSite,
    /// Player-facing site or collection name from the catalog.
    pub name: String,
    pub url: String,
    /// Catalog-authored setup guide for files from this source.
    pub instructions: String,
    /// The read-only browser this source can use, when it has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser: Option<ExternalModBrowser>,
    /// The current port and platform qualify for the optional read-only provider browser.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub browse_available: bool,
}

fn portal(
    port: &PortDefinition,
    platform: Platform,
    source: &crate::ModSource,
) -> Option<ExternalModPortal> {
    let (site, browser, browse_available) = match &source.source {
        ModSourceKind::ExternalPortal { site, .. } => (
            match site {
                ModPortalSite::NexusMods => ExternalModSite::NexusMods,
                ModPortalSite::ModIo => ExternalModSite::ModIo,
                ModPortalSite::ModDb => ExternalModSite::ModDb,
                ModPortalSite::CommunitySite => ExternalModSite::CommunitySite,
            },
            None,
            false,
        ),
        ModSourceKind::Quaddicted { .. } => (
            ExternalModSite::Quaddicted,
            Some(ExternalModBrowser::Quaddicted),
            crate::mod_source::quaddicted(port, platform).is_some(),
        ),
        ModSourceKind::ModDbFeed { .. } => (
            ExternalModSite::ModDb,
            Some(ExternalModBrowser::ModDbFeed),
            crate::quake_mod_browser::moddb_scope(port, platform).is_some(),
        ),
        // GitHub release sources have their own view and inspection route.
        ModSourceKind::GithubRelease { .. } => return None,
    };
    Some(ExternalModPortal {
        source: source.id.clone(),
        site,
        name: source.name.clone()?,
        url: source.link(),
        instructions: source.instructions.clone()?,
        browser,
        browse_available: browse_available && source.allows(ModSourceAuthority::Browse),
    })
}

pub(crate) fn portals(
    catalog: &Catalog,
    id: &str,
    platform: Option<Platform>,
) -> Vec<ExternalModPortal> {
    let (Some(platform), Ok(port)) = (platform, catalog.port(id)) else {
        return Vec::new();
    };
    if !crate::mod_source::presented_on(catalog, port, platform) {
        return Vec::new();
    }
    crate::mod_source::declared(port, platform)
        .filter_map(|source| portal(port, platform, source))
        .collect()
}

impl crate::PortcoveService {
    /// Recheck that a clicked destination belongs to the selected port and source.
    pub async fn review_external_mod_source_page(
        &self,
        port_id: &str,
        source: &str,
        url: &str,
    ) -> crate::Result<String> {
        let platform = Platform::current()?;
        let capability = portals(self.catalog(), port_id, Some(platform))
            .into_iter()
            .find(|portal| portal.source == source)
            .ok_or_else(|| {
                crate::PortcoveError::unsupported("This port has no reviewed route for this source")
            })?;
        if capability.url == url {
            return Ok(capability.url);
        }
        if capability.browse_available {
            match capability.browser {
                Some(ExternalModBrowser::Quaddicted) => {
                    return self.review_quaddicted_page(port_id, platform, url).await;
                }
                Some(ExternalModBrowser::ModDbFeed) => {
                    return self.review_moddb_notice(port_id, platform, url).await;
                }
                None => {}
            }
        }
        Err(crate::PortcoveError::verification(
            "This page is outside the reviewed portal",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_browser_only_link_checks_port_source_and_exact_page_before_opening() {
        let root = tempfile::tempdir().unwrap();
        let library = crate::Library::open(root.path().join("library")).unwrap();
        let service = crate::PortcoveService::new_read_only(library).unwrap();
        let platform = Platform::current().unwrap();
        let (port, portal) = service
            .catalog()
            .ports()
            .iter()
            .find_map(|port| {
                portals(service.catalog(), &port.id, Some(platform))
                    .into_iter()
                    .find(|portal| portal.browser.is_none())
                    .map(|portal| (port.id.clone(), portal))
            })
            .expect("the catalog declares a link-out portal on this host");
        assert_eq!(
            service
                .review_external_mod_source_page(&port, &portal.source, &portal.url)
                .await
                .unwrap(),
            portal.url
        );
        assert!(
            service
                .review_external_mod_source_page(
                    &port,
                    &portal.source,
                    &format!("{}?download=true", portal.url)
                )
                .await
                .is_err()
        );
        assert!(
            service
                .review_external_mod_source_page("starship", &portal.source, &portal.url)
                .await
                .is_err()
        );
        assert!(
            service
                .review_external_mod_source_page(&port, "undeclared-source", &portal.url)
                .await
                .is_err()
        );
    }

    #[test]
    fn public_profile_reads_surface_portals_before_installation() {
        let root = tempfile::tempdir().unwrap();
        let library = crate::Library::open(root.path().join("library")).unwrap();
        let service = crate::PortcoveService::new_read_only(library).unwrap();
        let platform = Platform::current().unwrap();
        let mut seen = 0;
        for port in service.catalog().ports() {
            if portals(service.catalog(), &port.id, Some(platform)).is_empty() {
                continue;
            }
            seen += 1;
            let desktop = service.preview_mod_handoff(&port.id).unwrap();
            let cli = service.mod_setups(&port.id).unwrap();
            assert!(!desktop.external_mod_portals.is_empty());
            assert_eq!(desktop.external_mod_portals, cli.external_mod_portals);
        }
        assert!(seen > 0);
    }

    #[test]
    fn unrelated_ports_and_unlisted_platforms_do_not_inherit_portals() {
        let catalog = Catalog::embedded().unwrap();
        assert!(portals(&catalog, "starship", Some(Platform::WindowsX86_64)).is_empty());
        assert!(portals(&catalog, "interkarma-daggerfall-unity", None).is_empty());
        assert!(
            portals(
                &catalog,
                "interkarma-daggerfall-unity",
                Some(Platform::MacosAarch64)
            )
            .is_empty()
        );
    }
}
